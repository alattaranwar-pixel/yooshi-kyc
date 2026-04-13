// ============================================================
// Yooshi KYC Screening Function
// Triggered by Shopify Flow when RealID tags an order
// Screens customer name against UN + MOFA sanctions lists
// ============================================================

const crypto = require("crypto");

// Load sanctions lists
const UN_LIST = require("../data/un-list.json");
const MOFA_LIST = require("../data/mofa-list.json");

// ── Helpers ──────────────────────────────────────────────────

/**
 * Normalize a name for fuzzy comparison:
 * lowercase, remove diacritics, collapse whitespace
 */
function normalizeName(name) {
  if (!name) return "";
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9\s]/g, "")     // remove punctuation
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Calculate similarity score between two normalized name strings.
 * Returns a value between 0 (no match) and 1 (exact match).
 * Uses token overlap to handle name order differences (e.g. "Ali Ahmed" vs "Ahmed Ali").
 */
function nameSimilarity(a, b) {
  const tokensA = new Set(a.split(" ").filter(Boolean));
  const tokensB = new Set(b.split(" ").filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let matches = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) matches++;
  }

  // Jaccard similarity: intersection / union
  const union = new Set([...tokensA, ...tokensB]).size;
  return matches / union;
}

/**
 * Screen a full name against a list of sanctioned entries.
 * Returns the best match if above the threshold, or null.
 */
function screenAgainstList(fullName, list, listName, threshold = 0.75) {
  const normalizedInput = normalizeName(fullName);
  let bestMatch = null;
  let bestScore = 0;

  for (const entry of list) {
    // Check primary name
    const primaryScore = nameSimilarity(normalizedInput, normalizeName(entry.name));
    if (primaryScore > bestScore) {
      bestScore = primaryScore;
      bestMatch = { ...entry, list: listName, score: primaryScore };
    }

    // Check aliases if present
    if (entry.aliases && Array.isArray(entry.aliases)) {
      for (const alias of entry.aliases) {
        const aliasScore = nameSimilarity(normalizedInput, normalizeName(alias));
        if (aliasScore > bestScore) {
          bestScore = aliasScore;
          bestMatch = { ...entry, matchedAlias: alias, list: listName, score: aliasScore };
        }
      }
    }
  }

  return bestScore >= threshold ? bestMatch : null;
}

/**
 * Add a fulfillment hold to a Shopify order via GraphQL
 */
async function addFulfillmentHold(shopDomain, accessToken, orderId, reason) {
  // First get the fulfillment order ID
  const getFulfillmentOrderQuery = `
    query getFulfillmentOrders($orderId: ID!) {
      order(id: $orderId) {
        fulfillmentOrders(first: 5) {
          nodes {
            id
            status
          }
        }
      }
    }
  `;

  const foResponse = await fetch(
    `https://${shopDomain}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: getFulfillmentOrderQuery,
        variables: { orderId },
      }),
    }
  );

  const foData = await foResponse.json();
  const fulfillmentOrders =
    foData?.data?.order?.fulfillmentOrders?.nodes || [];

  // Hold each open fulfillment order
  for (const fo of fulfillmentOrders) {
    if (fo.status === "OPEN") {
      const holdMutation = `
        mutation holdFulfillmentOrder($id: ID!, $reason: FulfillmentHoldReason!, $reasonNotes: String!) {
          fulfillmentOrderHold(
            id: $id
            fulfillmentHold: {
              reason: $reason
              reasonNotes: $reasonNotes
            }
          ) {
            fulfillmentOrder { id status }
            userErrors { field message }
          }
        }
      `;

      await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: holdMutation,
          variables: {
            id: fo.id,
            reason: "OTHER",
            reasonNotes: reason,
          },
        }),
      });
    }
  }
}

/**
 * Add tags to a Shopify order
 */
async function tagOrder(shopDomain, accessToken, orderId, tagsToAdd) {
  // First fetch existing tags
  const getTagsQuery = `
    query getOrderTags($id: ID!) {
      order(id: $id) { tags }
    }
  `;

  const tagsResponse = await fetch(
    `https://${shopDomain}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query: getTagsQuery, variables: { id: orderId } }),
    }
  );

  const tagsData = await tagsResponse.json();
  const existingTags = tagsData?.data?.order?.tags || [];
  const allTags = [...new Set([...existingTags, ...tagsToAdd])];

  const updateMutation = `
    mutation updateOrderTags($id: ID!, $tags: [String!]!) {
      orderUpdate(input: { id: $id, tags: $tags }) {
        order { id tags }
        userErrors { field message }
      }
    }
  `;

  await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: updateMutation,
      variables: { id: orderId, tags: allTags },
    }),
  });
}

/**
 * Add a private note to the order
 */
async function addOrderNote(shopDomain, accessToken, orderId, note) {
  const mutation = `
    mutation addNote($id: ID!, $note: String!) {
      orderUpdate(input: { id: $id, note: $note }) {
        order { id }
        userErrors { field message }
      }
    }
  `;

  await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: mutation,
      variables: { id: orderId, note },
    }),
  });
}

// ── Main Handler ─────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // Only accept POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify the shared secret sent by Shopify Flow
  const sharedSecret = process.env.FLOW_SHARED_SECRET;
  const incomingSecret = req.headers["x-kyc-secret"];

  if (!sharedSecret || incomingSecret !== sharedSecret) {
    console.error("Unauthorized request — invalid or missing secret");
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Parse body
  const body = req.body;
  const {
    order_id,           // Shopify GID e.g. "gid://shopify/Order/12345"
    order_name,         // e.g. "#1001"
    customer_first_name,
    customer_last_name,
    shop_domain,
  } = body;

  if (!order_id || !customer_first_name || !customer_last_name) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const fullName = `${customer_first_name} ${customer_last_name}`.trim();
  const shopDomain = shop_domain || process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  console.log(`[KYC] Screening: "${fullName}" for order ${order_name || order_id}`);

  try {
    // ── Screen against both lists ──────────────────────────
    const unMatch = screenAgainstList(fullName, UN_LIST, "UN Consolidated List");
    const mofaMatch = screenAgainstList(fullName, MOFA_LIST, "Kuwait MOFA National List");

    const isMatch = unMatch !== null || mofaMatch !== null;
    const matches = [unMatch, mofaMatch].filter(Boolean);

    if (isMatch) {
      // ── MATCH FOUND: hold order and flag for review ──────
      console.warn(`[KYC] MATCH FOUND for "${fullName}":`, matches);

      const matchSummary = matches
        .map(
          (m) =>
            `${m.list}: "${m.matchedAlias || m.name}" (score: ${(m.score * 100).toFixed(0)}%)`
        )
        .join("; ");

      const noteText = `⚠️ KYC ALERT — Sanctions screening flagged this order for manual review.\nCustomer name: "${fullName}"\nMatches: ${matchSummary}\nScreened at: ${new Date().toISOString()}\nAction required: Do not fulfill until compliance review is complete.`;

      // Tag order
      await tagOrder(shopDomain, accessToken, order_id, [
        "kyc-review",
        "sanctions-flag",
      ]);

      // Add fulfillment hold
      await addFulfillmentHold(
        shopDomain,
        accessToken,
        order_id,
        `KYC sanctions screening flagged this order. Matches: ${matchSummary}`
      );

      // Add private note
      await addOrderNote(shopDomain, accessToken, order_id, noteText);

      return res.status(200).json({
        result: "flagged",
        order: order_name,
        customer: fullName,
        matches: matchSummary,
      });

    } else {
      // ── NO MATCH: tag as cleared ─────────────────────────
      console.log(`[KYC] Clear: "${fullName}" — no matches found.`);

      await tagOrder(shopDomain, accessToken, order_id, ["kyc-cleared"]);

      return res.status(200).json({
        result: "cleared",
        order: order_name,
        customer: fullName,
      });
    }
  } catch (err) {
    console.error("[KYC] Error during screening:", err);
    return res.status(500).json({ error: "Internal screening error" });
  }
};
