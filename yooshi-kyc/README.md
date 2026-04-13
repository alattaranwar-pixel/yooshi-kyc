# Yooshi KYC Screening — Setup Guide

This function screens customers against the **UN Consolidated List** and the **Kuwait MOFA National List** whenever RealID completes an ID verification on a Shopify order.

## How It Works

```
Customer places order
        ↓
RealID verifies their ID
        ↓
RealID tags the order "ID verification completed" in Shopify
        ↓
Shopify Flow detects the tag → sends order data to this function
        ↓
Function screens customer name against both sanctions lists
        ↓
MATCH → Tags order "kyc-review" + adds fulfillment hold + adds note
NO MATCH → Tags order "kyc-cleared"
```

---

## Part 1 — Create a Shopify Admin API Token

You need a private API token so the function can tag orders and add fulfillment holds.

1. In your Shopify admin, go to **Settings → Apps and sales channels**
2. Scroll to the bottom and click **Develop apps**
3. Click **Allow custom app development** if prompted
4. Click **Create an app** → name it `KYC Screening`
5. Click **Configure Admin API scopes** and enable:
   - `write_orders` — to tag orders and add notes
   - `read_orders` — to read order details
   - `write_merchant_managed_fulfillment_orders` — to add fulfillment holds
   - `read_merchant_managed_fulfillment_orders`
6. Click **Save** → then click **Install app**
7. Click **Reveal token once** → copy it immediately and save it somewhere safe

> ⚠️ You can only see this token once. If you lose it, you'll need to create a new app.

---

## Part 2 — Deploy to Vercel

### 2a. Create a Vercel account
1. Go to [vercel.com](https://vercel.com) and sign up (free)
2. Sign up with GitHub — this makes deployment easiest

### 2b. Push this project to GitHub
1. Create a new **private** repository on GitHub called `yooshi-kyc`
2. Upload all files from this folder into it

### 2c. Deploy on Vercel
1. In Vercel dashboard, click **Add New → Project**
2. Import your `yooshi-kyc` GitHub repository
3. Leave all build settings as default
4. Click **Deploy**

### 2d. Set environment variables in Vercel
After deploying, go to your project → **Settings → Environment Variables** and add:

| Variable | Value |
|---|---|
| `SHOPIFY_SHOP_DOMAIN` | `yooshijewelry.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | The token you copied in Part 1 |
| `FLOW_SHARED_SECRET` | Make up a strong random password (e.g. `yooshi-kyc-2024-xK9mP2`) |

After adding variables, go to **Deployments → Redeploy** to apply them.

### 2e. Get your function URL
Your function URL will be:
```
https://your-project-name.vercel.app/api/kyc-screen
```
Copy this — you'll need it for Shopify Flow.

---

## Part 3 — Populate the Sanctions Lists

### UN Consolidated List
1. Download the XML file from:
   https://www.un.org/securitycouncil/content/un-sc-consolidated-list
2. Install Node dependencies: `npm install`
3. Run the converter:
   ```
   node scripts/convert-un-list.js path/to/consolidated.xml
   ```
4. This will overwrite `data/un-list.json` with all current entries
5. Commit and push to GitHub → Vercel will auto-redeploy

### Kuwait MOFA National List
1. Go to https://www.mofa.gov.kw/en/pagesNational_List
2. Manually copy names into `data/mofa-list.json` in this format:
   ```json
   [
     {
       "name": "Full Name In English",
       "name_arabic": "الاسم بالعربي",
       "aliases": ["Alternative Spelling", "Another Alias"],
       "nationality": "Kuwaiti",
       "listed_on": "2023-05-01"
     }
   ]
   ```
3. Remove the sample/instruction entry at the top
4. Commit and push → Vercel redeploys automatically

> 💡 **Arabic names tip:** Include both the Arabic original and common English transliterations as aliases. The screening function normalizes and compares names by token overlap, so "Mohammed" / "Muhammad" / "Mohamed" will all score similarly.

---

## Part 4 — Set Up Shopify Flow

1. In Shopify admin, go to **Apps → Flow**
2. Click **Create workflow**
3. Set the trigger: **Order tag added**
4. Add a condition: **Tag equals** `ID verification completed`
5. Add action: **Send HTTP request**
   - URL: your Vercel function URL from Part 2e
   - Method: `POST`
   - Headers:
     ```
     Content-Type: application/json
     x-kyc-secret: [your FLOW_SHARED_SECRET from Part 2d]
     ```
   - Body (use Flow's variable picker for the dynamic fields):
     ```json
     {
       "order_id": "{{ order.id }}",
       "order_name": "{{ order.name }}",
       "customer_first_name": "{{ order.customer.firstName }}",
       "customer_last_name": "{{ order.customer.lastName }}",
       "shop_domain": "yooshijewelry.myshopify.com"
     }
     ```
6. Click **Turn on workflow**

---

## Part 5 — What Happens After a Match

When a customer is flagged:

- Order is tagged `kyc-review` and `sanctions-flag`
- A fulfillment hold is placed — the order **cannot be shipped** until you manually release it
- A private note is added to the order with the match details and score

When a customer is cleared:

- Order is tagged `kyc-cleared`
- Fulfillment continues normally

### To review flagged orders in Shopify
Go to **Orders** and filter by tag `kyc-review`.

### To release a hold after manual review
Go to the order → **Fulfillment** section → click **Release hold**.

---

## Part 6 — Keeping Lists Updated

| List | How often to update | How |
|---|---|---|
| UN Consolidated List | When you receive notification of changes (UN emails member states) | Re-run `convert-un-list.js` with new XML |
| MOFA National List | When MOFA publishes updates | Manually update `data/mofa-list.json` |

After any update, commit and push to GitHub. Vercel deploys automatically within ~30 seconds.

---

## Matching Logic

The function uses **token-based fuzzy matching** with a 75% similarity threshold. This means:

- Name order doesn't matter: "Ali Ahmed Hassan" matches "Hassan Ali Ahmed"
- Minor spelling differences are tolerated
- Arabic name transliteration variations are handled via aliases

You can adjust the threshold in `api/kyc-screen.js` (line with `threshold = 0.75`):
- Higher (e.g. `0.85`) = fewer false positives, may miss variations
- Lower (e.g. `0.65`) = catches more variations, more false positives

---

## Future Expansion

To add OFAC or EU lists later:
1. Download their data files (both offer XML/CSV)
2. Convert to the same JSON format
3. Add a new list file to `data/`
4. Add one line in `kyc-screen.js`:
   ```js
   const OFAC_LIST = require("../data/ofac-list.json");
   const ofacMatch = screenAgainstList(fullName, OFAC_LIST, "OFAC SDN List");
   ```

---

## Support

If you have questions about this setup, the key files are:
- `api/kyc-screen.js` — the main function logic
- `data/un-list.json` — UN sanctions data
- `data/mofa-list.json` — MOFA national list data
- `scripts/convert-un-list.js` — UN XML converter
