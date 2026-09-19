require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const crypto = require('crypto');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── In-memory credit store ───────────────────────────────────────────────────
const creditStore = new Map();

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-session-id']
}));

// ─── PayMongo webhook ─────────────────────────────────────────────────────────
app.post('/webhook', express.json(), async (req, res) => {
  try {
    const event = req.body;

    // Verify webhook signature
    const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = req.headers['paymongo-signature'];
      if (signature) {
        const parts = signature.split(',').reduce((acc, part) => {
          const [key, val] = part.split('=');
          acc[key] = val;
          return acc;
        }, {});
        const payload = parts.t + '.' + JSON.stringify(req.body);
        const computedSig = crypto.createHmac('sha256', webhookSecret).update(payload).digest('hex');
        if (computedSig !== parts.te && computedSig !== parts.li) {
          return res.status(400).json({ error: 'Invalid signature' });
        }
      }
    }

    // Handle successful payment
    if (event.data?.attributes?.type === 'payment.paid' ||
        event.data?.attributes?.type === 'checkout_session.payment.paid') {
      const metadata = event.data?.attributes?.data?.attributes?.metadata ||
                       event.data?.attributes?.metadata || {};
      const sessionId = metadata.sessionId;
      const quantity = parseInt(metadata.quantity || '1');

      if (sessionId) {
        const existing = creditStore.get(sessionId) || { credits: 0 };
        creditStore.set(sessionId, {
          credits: existing.credits + quantity,
          lastUpdated: new Date()
        });
        console.log(`PayMongo payment complete: ${quantity} credit(s) added for session ${sessionId}`);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.json());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Create PayMongo checkout session ────────────────────────────────────────
app.post('/create-checkout', async (req, res) => {
  try {
    const { sessionId, quantity = 1 } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const pricePerVideo = parseInt(process.env.PRICE_PER_VIDEO_CENTS || '500');
    const totalAmount = pricePerVideo * quantity;

    // PayMongo uses centavos (PHP) or cents (USD) — amounts in smallest currency unit
    const paymongoKey = process.env.PAYMONGO_SECRET_KEY;
    const authHeader = 'Basic ' + Buffer.from(paymongoKey + ':').toString('base64');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const response = await fetch('https://api.paymongo.com/v1/checkout_sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({
        data: {
          attributes: {
            billing: { name: 'BabyTalk Customer' },
            send_email_receipt: true,
            show_description: true,
            show_line_items: true,
            line_items: [{
              currency: 'PHP',
              amount: totalAmount,
              name: `BabyTalk Video${quantity > 1 ? 's' : ''}`,
              description: `${quantity} personalized baby lip-sync video${quantity > 1 ? 's' : ''}`,
              quantity
            }],
            payment_method_types: ['card', 'gcash', 'maya'],
            success_url: `${frontendUrl}?payment=success&session=${sessionId}`,
            cancel_url: `${frontendUrl}?payment=cancelled`,
            metadata: { sessionId, quantity: String(quantity) }
          }
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data?.errors?.[0]?.detail || 'Failed to create checkout';
      throw new Error(errMsg);
    }

    const checkoutUrl = data.data?.attributes?.checkout_url;
    res.json({ checkoutUrl });

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
