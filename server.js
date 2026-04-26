require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── In-memory credit store ───────────────────────────────────────────────────
// For production, replace with a real database (Supabase, MongoDB, etc.)
// Key: sessionId, Value: { credits: number, usedAt: Date }
const creditStore = new Map();

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-session-id']
}));

// ─── Stripe webhook (must be before express.json()) ──────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const sessionId = session.metadata.sessionId;
    const quantity = parseInt(session.metadata.quantity || '1');

    // Add credits to the session
    const existing = creditStore.get(sessionId) || { credits: 0 };
    creditStore.set(sessionId, {
      credits: existing.credits + quantity,
      lastUpdated: new Date()
    });

    console.log(`Payment complete: ${quantity} credit(s) added for session ${sessionId}`);
  }

  res.json({ received: true });
});

app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Create Stripe checkout session ──────────────────────────────────────────
app.post('/create-checkout', async (req, res) => {
  try {
    const { sessionId, quantity = 1 } = req.body;

    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const pricePerVideo = parseInt(process.env.PRICE_PER_VIDEO_CENTS || '500');
    const totalAmount = pricePerVideo * quantity;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `BabyTalk Video${quantity > 1 ? 's' : ''}`,
            description: `${quantity} personalized baby lip-sync video${quantity > 1 ? 's' : ''}`,
            images: []
          },
          unit_amount: pricePerVideo
        },
        quantity
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}?payment=success&session=${sessionId}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}?payment=cancelled`,
      metadata: { sessionId, quantity: String(quantity) }
    });

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Check credits ────────────────────────────────────────────────────────────
app.get('/credits', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return res.status(400).json({ error: 'x-session-id header required' });

  const data = creditStore.get(sessionId) || { credits: 0 };
  res.json({ credits: data.credits });
});

// ─── Generate video ───────────────────────────────────────────────────────────
app.post('/generate', upload.single('image'), async (req, res) => {
  const sessionId = req.headers['x-session-id'];

  // 1. Validate session and credits
  if (!sessionId) return res.status(400).json({ error: 'x-session-id header required' });

  const data = creditStore.get(sessionId) || { credits: 0 };
  if (data.credits < 1) {
    return res.status(402).json({ error: 'No credits remaining. Please purchase more videos.' });
  }

  const { script, voiceProvider, voiceId } = req.body;
  const imageFile = req.file;

  if (!script) return res.status(400).json({ error: 'Script is required' });
  if (!imageFile) return res.status(400).json({ error: 'Image is required' });
  if (!voiceProvider || !voiceId) return res.status(400).json({ error: 'Voice selection is required' });

  try {
    // 2. Upload image to D-ID
    console.log('Uploading image to D-ID...');
    const formData = new FormData();
    formData.append('image', imageFile.buffer, {
      filename: imageFile.originalname || 'image.jpg',
      contentType: imageFile.mimetype
    });

    const uploadRes = await fetch('https://api.d-id.com/images', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(process.env.DID_API_KEY + ':').toString('base64'),
        ...formData.getHeaders()
      },
      body: formData
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      throw new Error(err.description || 'Image upload to D-ID failed');
    }

    const uploadData = await uploadRes.json();
    const imageUrl = uploadData.url;

    // 3. Build voice provider config
    let voiceConfig;
    if (voiceProvider === 'elevenlabs') {
      voiceConfig = {
        type: 'elevenlabs',
        voice_id: voiceId,
        voice_config: {
          api_key: process.env.ELEVENLABS_API_KEY,
          stability: 0.85,
          similarity_boost: 0.35,
          style: 0,
          use_speaker_boost: false
        }
      };
    } else if (voiceProvider === 'microsoft-baby') {
      voiceConfig = {
        type: 'microsoft',
        voice_id: voiceId,
        voice_config: { style: 'cheerful', style_degree: 2 }
      };
    } else {
      voiceConfig = { type: 'microsoft', voice_id: voiceId };
    }

    // 4. Create D-ID talk
    console.log('Creating D-ID talk...');
    const talkRes = await fetch('https://api.d-id.com/talks', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(process.env.DID_API_KEY + ':').toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        source_url: imageUrl,
        script: { type: 'text', input: script, provider: voiceConfig },
        config: { fluent: true, pad_audio: 0 }
      })
    });

    if (!talkRes.ok) {
      const err = await talkRes.json().catch(() => ({}));
      throw new Error(err.description || 'Failed to create D-ID talk');
    }

    const talkData = await talkRes.json();
    const talkId = talkData.id;

    // 5. Deduct 1 credit immediately after successful job creation
    creditStore.set(sessionId, {
      credits: data.credits - 1,
      lastUpdated: new Date()
    });

    // 6. Return talkId — frontend will poll for status
    res.json({ talkId, creditsRemaining: data.credits - 1 });

  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: err.message || 'Video generation failed' });
  }
});

// ─── Poll video status ────────────────────────────────────────────────────────
app.get('/status/:talkId', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return res.status(400).json({ error: 'x-session-id header required' });

  try {
    const statusRes = await fetch(`https://api.d-id.com/talks/${req.params.talkId}`, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(process.env.DID_API_KEY + ':').toString('base64')
      }
    });

    const statusData = await statusRes.json();
    res.json({
      status: statusData.status,
      resultUrl: statusData.result_url || null,
      error: statusData.description || null
    });
  } catch (err) {
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BabyTalk backend running on port ${PORT}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
});
