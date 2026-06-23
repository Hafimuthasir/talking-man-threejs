const SYSTEM_PROMPT = `You are Alex, a professional and friendly virtual bank assistant for Nova Bank.
Keep every answer to 2-3 sentences — your reply will be spoken aloud.
Only answer bank-related questions. If someone asks about anything else, politely say you can only help with banking topics.

NOVA BANK KNOWLEDGE BASE:

Accounts:
- Savings Account: 4.5% annual interest, $500 minimum balance, free online banking
- Checking Account: no minimum balance, free debit card, 300 free transactions/month
- Fixed Deposit: 6.2% for 1 year, 6.8% for 2 years, 7.1% for 3 years, minimum $1,000

Loans:
- Home Loan: 8.5% p.a., up to 30-year tenure, up to $2,000,000
- Personal Loan: 12% p.a., up to 5 years, up to $50,000
- Car Loan: 9.5% p.a., up to 7 years, up to $100,000
- Education Loan: 7.5% p.a., up to 15 years, up to $150,000

Credit Cards:
- Nova Classic: no annual fee, 1% cashback on all purchases
- Nova Gold: $99/year, 2% cashback, travel insurance included
- Nova Platinum: $299/year, 3% cashback, airport lounge access, concierge service

Digital Banking:
- Mobile app on iOS and Android
- Internet banking at novabank.com
- Supports UPI, NEFT, RTGS, IMPS transfers
- Daily online transfer limit: $10,000

Account Opening & KYC:
- Open an account online in 10 minutes
- Required documents: government-issued ID, address proof
- Video KYC available, minimum age 18

Branch & ATM Hours:
- Branches: Monday–Friday 9 AM–5 PM, Saturday 10 AM–2 PM, Sunday closed
- ATMs: open 24/7

Fees:
- ATM withdrawals at Nova ATMs: free
- ATM withdrawals at other banks: $2.50 after 5 free/month
- Domestic wire transfer: $25, international: $45
- First chequebook (25 leaves): free

Customer Support: 1-800-NOVA-BANK, available 24/7`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { message, history = [] } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'No message provided' });
  }

  // Build the message list:
  //   [system prompt]            — bank knowledge, always present
  //   [...history]               — trimmed prior context from the frontend
  //   [{ role: user, message }]  — the actual question, always last
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.filter(m => m.role && m.content),
    { role: 'user', content: message.trim() },
  ];

  // --- Groq LLM ---
  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 120,
      temperature: 0.6,
    }),
  });

  if (!groqRes.ok) {
    console.error('Groq error:', await groqRes.text());
    return res.status(502).json({ error: 'LLM unavailable' });
  }

  const groqData = await groqRes.json();
  const reply = groqData.choices[0].message.content.trim();

  // --- ElevenLabs TTS (Adam voice, turbo model) ---
  const ttsRes = await fetch(
    'https://api.elevenlabs.io/v1/text-to-speech/pNInz6obpgDQGcFmaJgB',
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: reply,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!ttsRes.ok) {
    console.error('ElevenLabs error:', await ttsRes.text());
    return res.status(502).json({ error: 'TTS unavailable' });
  }

  const audioBuffer = await ttsRes.arrayBuffer();

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('X-Reply-Text', encodeURIComponent(reply));
  res.send(Buffer.from(audioBuffer));
};
