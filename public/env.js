// Copy this file to /env.js and fill in your values.
// Supabase anon key is public by design. TURN is strongly recommended in production.
window.ENV = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-SUPABASE-ANON-KEY",
  ICE_SERVERS: [
    { urls: "stun:stun.l.google.com:19302" },
    // Add a TURN service for reliability (Twilio, Xirsys, Cloudflare Calls, or your Coturn)
    // { urls: "turn:YOUR_TURN_HOST:3478", username: "USER", credential: "PASS" }
  ]
};
