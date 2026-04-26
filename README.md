# BabyTalk Backend — Vercel Deployment Guide

## What's in this folder

```
babytalk-vercel/
├── server.js          ← Main backend (handles payments + video generation)
├── package.json       ← Node.js dependencies
├── vercel.json        ← Vercel deployment config
├── .env.example       ← Copy this to .env for local testing
└── public/
    └── index.html     ← Your frontend (served automatically by Vercel)
```

---

## Step 1 — Get your API keys ready

| Key | Where to get it |
|-----|----------------|
| D-ID API Key | studio.d-id.com → Profile → API |
| ElevenLabs API Key | elevenlabs.io → Profile → API Keys |
| Stripe Secret Key | dashboard.stripe.com → Developers → API Keys |
| Stripe Webhook Secret | Set up in Step 5 below |

---

## Step 2 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial BabyTalk"
git remote add origin https://github.com/YOURUSERNAME/babytalk.git
git push -u origin main
```

---

## Step 3 — Deploy to Vercel

1. Go to **vercel.com** → sign up free
2. Click **Add New → Project**
3. Import your GitHub repo
4. Click **Deploy** — done!

Your app will be live at `https://babytalk-xxx.vercel.app`

To use your own domain: Vercel Dashboard → Settings → Domains → add `yourdomain.com`

---

## Step 4 — Set environment variables in Vercel

Vercel Dashboard → your project → **Settings → Environment Variables**:

```
DID_API_KEY           = your_did_api_key
ELEVENLABS_API_KEY    = your_elevenlabs_api_key
STRIPE_SECRET_KEY     = sk_live_xxxx
STRIPE_WEBHOOK_SECRET = whsec_xxxx
FRONTEND_URL          = https://yourdomain.com
PRICE_PER_VIDEO_CENTS = 500
```

After adding → go to **Deployments → Redeploy**.

---

## Step 5 — Set up Stripe Webhook

1. **dashboard.stripe.com → Developers → Webhooks → Add Endpoint**
2. URL: `https://yourdomain.com/webhook`
3. Event: `checkout.session.completed`
4. Copy the **Signing Secret** → add as `STRIPE_WEBHOOK_SECRET` in Vercel → Redeploy

---

## Step 6 — Update frontend URL

Open `public/index.html`, find this line and update it:

```javascript
const BACKEND_URL = 'https://yourdomain.com';
```

Then push to GitHub — Vercel auto-redeploys:
```bash
git add . && git commit -m "Update backend URL" && git push
```

---

## Step 7 — Test with Stripe test card

1. Visit your site, click "1 Video — $5"
2. Use test card: **4242 4242 4242 4242** (any expiry/CVC)
3. Credit appears, upload photo, write script, generate!

---

## Going live

Swap `STRIPE_SECRET_KEY` to your live key (`sk_live_...`), create a new live Stripe webhook, update `STRIPE_WEBHOOK_SECRET`, redeploy.

## Changing the price

Update `PRICE_PER_VIDEO_CENTS` in Vercel Variables and redeploy. No code changes needed.
