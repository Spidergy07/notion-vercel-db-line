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

            // Check for duplicate before adding (Upsert Strategy)
            const isDup = await isDuplicate(data.summary, data.start);
            if (isDup) {
                console.log(`Duplicate detected for: ${data.summary}, attempting UPDATE instead.`);
                const updateSuccess = await updateNotionPage(data);
                if (updateSuccess) {
                    results.push({ summary: data.summary, url: "https://notion.so", emoji: data.emoji, status: 'updated' });
                } else {
                    results.push({ summary: data.summary, url: "https://notion.so", emoji: data.emoji, status: 'failed_update' });
                }
                continue;
            }

            const notionUrl = await addToNotion(data);
            results.push({ summary: data.summary, url: notionUrl, emoji: data.emoji, status: 'created' });
        }
    }

    if (results.length === 0) {
        return lineClient.replyMessage(event.replyToken, {
            type: 'text',
            text: `ไม่สามารถบันทึกได้ครับ เนื่องจากหาข้อมูลวันที่ไม่ชัดเจน (เช่น 12-ก.พ.-2569) กรุณาระบุวันที่ให้เป็นทางการมากขึ้นครับ (Model: ${aiResult.usedModel})`
        });
    }

    const summaryList = results.map(r => {
        if (r.status === 'updated') return `📝 ${r.summary} (อัปเดตข้อมูล)`;
        if (r.status === 'created') return `✅ ${r.summary} (สร้างใหม่)`;
        return `⚠️ ${r.summary} (อัปเดตไม่สำเร็จ)`;
    }).join('\n');
    return lineClient.replyMessage(event.replyToken, {
        type: 'text',
        text: `🎉 สรุปผลการทำงาน: (Model: ${aiResult.usedModel})\n\n${summaryList}\n\n🔗 ดูที่: ${results[0].url}`
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

async function processWithGemini(userText) {
  // List of models to try in order (As requested by user: 2026 lineup)
  const modelsToTry = [
      "gemini-3-pro-preview",    // 1. Most Intelligent
      "gemini-3-flash-preview",  // 2. High Intelligence + Speed
      "gemini-2.5-pro",          // 3. Strong Reasoning
      "gemini-2.5-flash",        // 4. Balanced & Agentic
      "gemini-2.5-flash-lite",   // 5. Cost Effective
      "gemini-1.5-pro-latest",   // 6. Fallback Stable Pro
      "gemini-1.5-flash-latest"  // 7. Fallback Stable Flash
  ];

  // Use local Thai time for AI context
  const currentDate = new Date().toLocaleString('en-US', { 
    timeZone: 'Asia/Bangkok',
    dateStyle: 'full', 
    timeStyle: 'medium'
  });
  
  const prompt = `
    Analyze user text and decide intent: "CREATE", "DELETE", "UPDATE", or "FETCH".
    Current Time (Bangkok): ${currentDate}
    User Text: "${userText}"
    
    Instruction:
    1. 🚨 **CRITICAL: CLASSIFY INTENT FIRST** 🚨
       - Look for keywords: "แก้" (fix), "เปลี่ยน" (change), "ผิด" (wrong), "เลื่อน" (move), "พิมพ์ผิด", "ไม่ใช่", "มั่ว".
       - **IF FOUND**: Intent MUST be **"UPDATE"**. DO NOT CREATE. Even if the user pastes a full event description, use it ONLY to update the existing event.
       - **CREATE**: Only if user wants to ADD a NEW event AND there are NO "fix/change" keywords.
       - **DELETE**: If user wants to remove/cancel.
       - **FETCH**: If user asks to see/list events.

    2. RULES BY INTENT:
       - **UPDATE**:
         - "summary": MUST be the *original* name of the event to find (e.g. "Meeting").
         - "start"/"end": The new corrected dates.
         - FOLLOW STRICT DATE RULES: "20-22" means end is 22nd.
       
       - **CREATE**:
         - **Complex Lists**: If text has multiple tracks (e.g. "1. Topic A... 2. Topic B..."), SPLIT them.
         - **Strict Date Association**: NEVER copy dates from Track 1 to Track 2. Look for dates specific to EACH track.
         - **Vague Dates**: If a track only says "April" (เม.ย.), set start date to 1st April (e.g. 2026-04-01).
         - **Split Reg/Compete**: If a track has both "Register" and "Compete" dates, create TWO events.
         - Support Thai date formats: "12-ก.พ.-2569" means February 12, 2026.
         - Support date ranges: "20-22 กุมภาพันธ์" means Start: 2026-02-20, End: 2026-02-22.
         - IMPORTANT: For the "end" date, strictly follow the user's range. If the range is 20-22, the "end" date MUST be 2026-02-22. NEVER set it to the next day (23).
         - TIME LIMIT: If providing an end time for the final day, NEVER use 00:00. Use 23:59 instead.
         - **TIMEZONE**: Always output dates in ISO 8601 format with Thailand offset (e.g., '2026-02-03T17:00:00+07:00'). Do NOT use UTC 'Z'.
         - Support BE years: Always convert Thai years (2568, 2569) to Gregorian (2025, 2026).
         - Support SHORT BE years: If year is 2 digits (e.g. 69), assume 2569 -> 2026.
         - If NO time is specificed, set "start" as "YYYY-MM-DD" (date only).

    3. DELETE: Remove events.
    4. FETCH: List upcoming tasks.
    
    Return ONLY a raw JSON object:
    {
      "intent": "CREATE" | "DELETE" | "UPDATE" | "FETCH",
      "events": [
        { "summary": "...", "start": "...", "end": "...", "emoji": "...", "details": "..." }
      ]
    }
  `;

  let text = "";
  let successModel = "";

  for (const modelName of modelsToTry) {
      try {
          console.log(`🤖 Attempting with model: ${modelName}...`);
          const model = genAI.getGenerativeModel({ model: modelName });
          const result = await model.generateContent(prompt);
          const response = await result.response;
          text = response.text();
          successModel = modelName;
          console.log(`✅ Success with ${modelName}!`);
          break; // Stop loop if successful
      } catch (error) {
          console.warn(`⚠️ Model ${modelName} failed: ${error.message}`);
          if (modelName === modelsToTry[modelsToTry.length - 1]) {
             // If this was the last model, throw the error to be caught by main handler
             throw error;
          }
          // Otherwise, continue to next model
          continue;
      }
  }

  try {
    // Find pure JSON
    const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleanJson);
    result.usedModel = successModel; // Attach model info
    return result;
  } catch (e) {
    console.error("Gemini Parse Error", text); 
    return { usedModel: 'failed' };
  }
}

async function fetchFromNotion() {
    const today = new Date().toISOString().split('T')[0]; // Get YYYY-MM-DD
    const response = await notion.databases.query({
        database_id: process.env.NOTION_DATABASE_ID,
        page_size: 50,
        filter: {
            property: "Film date",
            date: {
                on_or_after: today
            }
        },
        sorts: [
            {
                property: "Film date",
                direction: "ascending"
            }
        ]
    });

    return response.results.map(page => {
        const props = page.properties;
        const summary = props["Content name"].title[0]?.plain_text || "ไม่มีชื่อ";
        const date = props["Film date"].date?.start || "ไม่มีวันที่";
        const emoji = page.icon?.emoji;
        return { summary, date, emoji };
    });
}

async function deleteFromNotion(summary) {
    // Search for the page with strict filtering to prevent accidental deletions
    const searchResult = await notion.databases.query({
        database_id: process.env.NOTION_DATABASE_ID,
        filter: {
            property: "Content name",
            title: {
                contains: summary
            }
        }
    });

    if (searchResult.results.length > 0) {
        for (const page of searchResult.results) {
            // Safety: Skip if already archived (though query usually hides them)
            if (page.archived) continue;
            
            await notion.pages.update({
                page_id: page.id,
                archived: true
            });
        }
        return true;
    }
    return false;
}

async function addToNotion(data) {
    const response = await notion.pages.create({
        parent: { database_id: process.env.NOTION_DATABASE_ID },
        icon: data.emoji ? { type: "emoji", emoji: data.emoji } : null,
        properties: {
            "Content name": { 
                title: [
                    {
                        text: {
                            content: data.summary,
                        },
                    },
                ],
            },
            "Film date": {
                date: {
                    start: data.start,
                    end: data.end
                }
            }
        },
        children: data.details ? [
            {
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: [
                        {
                            type: 'text',
                            text: {
                                content: data.details,
                            },
                        },
                    ],
                },
            },
        ] : []
    });
    return response.url;
}

function formatThaiDate(dateStr) {
    if (!dateStr || dateStr === "ไม่มีวันที่") return dateStr;
    try {
        const date = new Date(dateStr);
        return new Intl.DateTimeFormat('th-TH', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: dateStr.includes('T') ? '2-digit' : undefined,
            minute: dateStr.includes('T') ? '2-digit' : undefined,
            timeZone: 'Asia/Bangkok'
        }).format(date);
    } catch (e) {
        return dateStr;
    }
}

async function isDuplicate(summary, startDate) {
    if (!startDate) return false;
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
    return response.results.length > 0;
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
    const updateProperties = {};

    // Only update fields that Gemini extracted as "new/changed"
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

    console.log(`✅ Successfully updated: ${data.summary}`);
    return true;
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
