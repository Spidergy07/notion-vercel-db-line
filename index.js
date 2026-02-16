const express = require('express');
const { Client } = require('@notionhq/client');
const line = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Configuration
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// LINE Client
const lineClient = new line.Client(lineConfig);

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;
    if (events.length > 0) {
      // We MUST await here on Vercel, otherwise the function terminates before processing finishes
      await Promise.all(events.map(handleEvent));
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;

  try {
    // 1. Process with Gemini
    console.log("Processing message:", userMessage);
    const aiResult = await processWithGemini(userMessage);
    console.log("AI Result:", JSON.stringify(aiResult));

    if (!aiResult || !aiResult.intent) {
        return lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: 'ขอโทษครับ ผมไม่เข้าใจคำสั่ง หรือไม่พบข้อมูลในข้อความครับ'
        });
    }

    // Handle FETCH / LIST intent
    if (aiResult.intent === 'FETCH') {
        const list = await fetchFromNotion();
        console.log(`Fetched ${list.length} items from Notion`);

        if (list.length === 0) {
            return lineClient.replyMessage(event.replyToken, {
                type: 'text',
                text: 'ไม่พบกิจกรรมในปฏิทินเลยครับ 📭'
            });
        }
        
        let listText = list.map((item, index) => {
            const formattedDate = formatThaiDate(item.date);
            return `${index + 1}. ${item.emoji || '📅'} ${item.summary}\n⏰ ${formattedDate}`;
        }).join('\n' + '⎯'.repeat(12) + '\n');

        // Safety: Limit message length for LINE (5000 chars)
        if (listText.length > 4000) {
            listText = listText.substring(0, 4000) + "\n\n...(รายการยาวเกินไป กรุณาดูต่อใน Notion ครับ)";
        }

        return lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: `📋 รายการกิจกรรม (50 อันดับล่าสุด)\n━━━━━━━━━━━━━━\n\n${listText}`
        });
    }

    // Handle DELETE intent
    if (aiResult.intent === 'DELETE') {
        const deletedSummaries = [];
        if (aiResult.events && Array.isArray(aiResult.events)) {
            for (const item of aiResult.events) {
                const success = await deleteFromNotion(item.summary);
                if (success) deletedSummaries.push(item.summary);
            }
        }

        if (deletedSummaries.length > 0) {
            return lineClient.replyMessage(event.replyToken, {
                type: 'text',
                text: `🗑️ ลบกิจกรรมเรียบร้อยแล้ว!\n\n${deletedSummaries.map(s => `❌ ${s}`).join('\n')}`
            });
        } else {
            return lineClient.replyMessage(event.replyToken, {
                type: 'text',
                text: 'ขอโทษครับ ผมหาชื่อกิจกรรมที่ระบุไม่เจอใน Notion ครับ'
            });
        }
    }

    // Handle UPDATE intent
    if (aiResult.intent === 'UPDATE') {
        const updatedSummaries = [];
        for (const item of aiResult.events) {
            const success = await updateNotionPage(item);
            if (success) updatedSummaries.push(item.summary);
        }

        if (updatedSummaries.length > 0) {
            return lineClient.replyMessage(event.replyToken, {
                type: 'text',
                text: `📝 อัปเดตกิจกรรมเรียบร้อยแล้ว! (Model: ${aiResult.usedModel})\n\n${updatedSummaries.map(s => `✅ ${s}`).join('\n')}`
            });
        } else {
            return lineClient.replyMessage(event.replyToken, {
                type: 'text',
                text: `ขอโทษครับ ผมหาชื่อกิจกรรมที่จะอัปเดตไม่เจอครับ (Model: ${aiResult.usedModel})`
            });
        }
    }

    // Default: CREATE intent
    const results = [];
    if (aiResult.events && Array.isArray(aiResult.events)) {
        for (const data of aiResult.events) {
            // Safety: Skip if no start date was extracted
            if (!data.start) {
                console.log(`Skipping event without date: ${data.summary}`);
                continue;
            }

            // Check for existing event on the same date (Upsert logic)
            const existingPageId = await findGenericEvent(data.summary, data.start);
            
            if (existingPageId) {
                console.log(`Duplicate detected for: ${data.summary} (ID: ${existingPageId}). Updating instead...`);
                await updatePageDirectly(existingPageId, data);
                results.push({ summary: data.summary, url: "https://notion.so", emoji: data.emoji, action: "updated" });
                continue;
            }

            const notionUrl = await addToNotion(data);
            results.push({ summary: data.summary, url: notionUrl, emoji: data.emoji, action: "created" });
        }
    }

    if (results.length === 0) {
        return lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: `ไม่สามารถบันทึกได้ครับ เนื่องจากหาข้อมูลวันที่ไม่ชัดเจน (เช่น 12-ก.พ.-2569) กรุณาระบุวันที่ให้เป็นทางการมากขึ้นครับ (Model: ${aiResult.usedModel})`
        });
    }

    const summaryList = results.map(r => {
        if (r.action === "updated") return `🔄 ${r.summary} (อัปเดตเวลา/ข้อมูลใหม่)`;
        if (r.alreadyExists) return `⚠️ ${r.summary} (มีอยู่แล้ว)`; // Legacy fallback
        return `✅ ${r.summary}`;
    }).join('\n');

    return lineClient.replyMessage(event.replyToken, {
        type: 'text',
        text: `🎉 บันทึกเสร็จสิ้น (v2): (Model: ${aiResult.usedModel})\n\n${summaryList}\n\n🔗 ดูที่: ${results[0].url}`
    });

  } catch (error) {
    console.error('Detailed Error:', JSON.stringify(error, null, 2));
    // Important: Don't use replyToken more than once!
    // If the error happened DURING a replyMessage, we might not be able to reply again.
    try {
        // Only try to reply if it's not a LINE request error (which likely means the token is dead)
        if (!error.originalError) {
             await lineClient.replyMessage(event.replyToken, {
                type: 'text',
                text: `เกิดข้อผิดพลาด: ${error.message || 'รหัส 500'}`
            });
        }
    } catch (err) {
        console.error("Critical: Could not send error message to LINE:", err.message);
    }
  }
}

// ... helper functions ...

async function findGenericEvent(summary, startDate) {
    if (!startDate) return null;
    const dateQuery = startDate.split('T')[0];
    const response = await notion.databases.query({
        database_id: process.env.NOTION_DATABASE_ID,
        filter: {
            and: [
                {
                    property: "Content name",
                    title: {
                        contains: summary
                    }
                },
                {
                    property: "Film date",
                    date: {
                        on_or_after: dateQuery,
                        on_or_before: dateQuery
                    }
                }
            ]
        }
    });
    return response.results.length > 0 ? response.results[0].id : null;
}

async function updatePageDirectly(pageId, data) {
    const updateProperties = {};

    // Update Date/Time
    if (data.start) {
        updateProperties["Film date"] = {
            date: { start: data.start, end: data.end || null }
        };
    }

    // Perform update
    await notion.pages.update({
        page_id: pageId,
        properties: updateProperties,
        icon: data.emoji ? { type: "emoji", emoji: data.emoji } : undefined
    });

    console.log(`✅ Successfully updated directly: ${data.summary}`);
    return true;
}

async function updateNotionPage(data) {
    // Search for the page with STRICT filtering to prevent accidental updates
    const searchResult = await notion.databases.query({
        database_id: process.env.NOTION_DATABASE_ID,
        filter: {
            property: "Content name",
            title: {
                contains: data.summary
            }
        },
        page_size: 1
    });

    if (searchResult.results.length === 0) {
        console.warn(`❌ Update failed: Could not find event with name "${data.summary}"`);
        return false;
    }

    const pageId = searchResult.results[0].id;
    return await updatePageDirectly(pageId, data);
}

function createFlexList(list) {
    const contents = list.slice(0, 10).map(item => ({
        type: "box",
        layout: "vertical",
        margin: "md",
        contents: [
            {
                type: "text",
                text: `${item.emoji || '📅'} ${item.summary}`,
                weight: "bold",
                size: "md",
                color: "#111111",
                wrap: true
            },
            {
                type: "text",
                text: formatThaiDate(item.date),
                size: "xs",
                color: "#aaaaaa",
                margin: "xs"
            },
            {
                type: "separator",
                margin: "md"
            }
        ]
    }));

    return {
        type: "flex",
        altText: "รายการกิจกรรมของคุณ",
        contents: {
            type: "bubble",
            header: {
                type: "box",
                layout: "vertical",
                contents: [
                    {
                        type: "text",
                        text: "ตารางกิจกรรมของคุณ 📋",
                        weight: "bold",
                        size: "lg",
                        color: "#FFFFFF"
                    }
                ],
                backgroundColor: "#06C755"
            },
            body: {
                type: "box",
                layout: "vertical",
                contents: contents
            }
        }
    };
}

function createFlexSuccess(results) {
    return {
        type: "flex",
        altText: "บันทึกสำเร็จ",
        contents: {
            type: "bubble",
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    {
                        type: "text",
                        text: "บันทึกข้อมูลเรียบร้อย! 🎉",
                        weight: "bold",
                        size: "xl",
                        color: "#06C755"
                    },
                    {
                        type: "box",
                        layout: "vertical",
                        margin: "lg",
                        spacing: "sm",
                        contents: results.map(r => ({
                            type: "text",
                            text: `✅ ${r.summary}`,
                            size: "md",
                            color: "#666666",
                            wrap: true
                        }))
                    }
                ]
            },
            footer: {
                type: "box",
                layout: "vertical",
                contents: [
                    {
                        type: "button",
                        action: {
                            type: "uri",
                            label: "เปิดดูปฏิทินใน Notion",
                            uri: results[0].url || "https://notion.so"
                        },
                        style: "primary",
                        color: "#06C755"
                    }
                ]
            }
        }
    };
}

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
}

module.exports = app;
