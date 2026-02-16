require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function processWithGemini(userText) {
  const modelsToTry = [
      "gemini-3-pro-preview",    // 1. Most Intelligent
      "gemini-3-flash-preview",  // 2. High Intelligence + Speed
      "gemini-2.5-pro",          // 3. Strong Reasoning
      "gemini-2.5-flash",        // 4. Balanced & Agentic
      "gemini-2.5-flash-lite",   // 5. Cost Effective
      "gemini-1.5-pro-latest",   // 6. Fallback Stable Pro
      "gemini-1.5-flash-latest"  // 7. Fallback Stable Flash
  ];

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
         - **TIME PRESERVATION**: If the user mentions a time (e.g., "10 โมง", "13:00", "บ่าย 2", "10.30"), you MUST include it in the ISO string.
         - **Specific Thai Time**: "10 โมง" = 10:00, "บ่าย 2" = 14:00, "2 ทุ่ม" = 20:00.
         - Support BE years: Always convert Thai years (2568, 2569) to Gregorian (2025, 2026).
         - If NO time is specificed, set "start" as "YYYY-MM-DD" (date only).
         - **Timezone**: Always use valid ISO 8601 with offset +07:00 (e.g., '2026-02-03T17:00:00+07:00').

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
          if (modelName === modelsToTry[modelsToTry.length - 1]) throw error;
          continue;
      }
  }

  try {
    const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleanJson);
    result.usedModel = successModel;
    return result;
  } catch (e) {
    console.error("Gemini Parse Error", text); 
    return { usedModel: 'failed' };
  }
}

const testText = "Quiz#1 DB Designs (15:45) (จ16/02/69)";
processWithGemini(testText).then(res => console.log(JSON.stringify(res, null, 2))).catch(console.error);
