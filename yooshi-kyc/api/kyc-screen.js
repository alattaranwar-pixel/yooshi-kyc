// ============================================================
// Yooshi KYC Screening Function v2
// Improved Arabic name matching with:
// - Lower threshold (60%) for transliteration variations
// - Partial/single token matching for short names
// - Arabic script direct matching
// - Vowel-insensitive comparison
// ============================================================

const UN_LIST = require("../data/un-list.json");
const MOFA_LIST = require("../data/mofa-list.json");

// ── Name Normalization ────────────────────────────────────────

/**
 * Normalize Latin script name:
 * lowercase, remove diacritics, remove punctuation, collapse spaces
 */
function normalizeLatin(name) {
  if (!name) return "";
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize Arabic script name:
 * remove diacritics (tashkeel), normalize alef variants, collapse spaces
 */
function normalizeArabic(name) {
  if (!name) return "";
  return name
    .replace(/[\u064B-\u065F\u0670]/g, "") // remove tashkeel
    .replace(/[أإآا]/g, "ا")               // normalize alef
    .replace(/ة/g, "ه")                    // normalize taa marbuta
    .replace(/ى/g, "ي")                    // normalize alef maqsura
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Remove common Arabic vowel representations in transliteration
 * to improve fuzzy matching (e.g. "Talal" vs "Tlal")
 */
function removeLatinVowels(name) {
  return name.replace(/[aeiou]/g, "").replace(/\s+/g, " ").trim();
}

// ── Similarity Scoring ────────────────────────────────────────

/**
 * Token overlap similarity (Jaccard) between two normalized strings
 */
function tokenSimilarity(a, b) {
  const tokensA = new Set(a.split(" ").filter(t => t.length > 1));
  const tokensB = new Set(b.split(" ").filter(t => t.length > 1));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let matches = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) matches++;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return matches / union;
}

/**
 * Vowel-stripped token similarity — helps with Arabic transliteration
 * where vowels are often omitted or inconsistent
 */
function consonantSimilarity(a, b) {
  return tokenSimilarity(removeLatinVowels(a), removeLatinVowels(b));
}

/**
 * Check if ANY single token from input appears in the candidate name.
 * Used for partial name matching (e.g. single-name individuals).
 * Only triggers for tokens longer than 3 chars to avoid false positives.
 */
function hasSignificantTokenOverlap(inputTokens, candidateStr) {
  for (const token of inputTokens) {
    if (token.length > 3 && candidateStr.includes(token)) {
      return true;
    }
  }
  return false;
}

/**
 * Composite score combining multiple matching strategies
 */
function compositeScore(input, candidate) {
  const scores = [];

  // Strategy 1: Direct token similarity
  scores.push(tokenSimilarity(input, candidate));

  // Strategy 2: Vowel-stripped similarity (handles transliteration gaps)
  scores.push(consonantSimilarity(input, candidate) * 0.9); // slight penalty

  // Strategy 3: Substring check for very short names
  const inputTokens = input.split(" ").filter(t => t.length > 3);
  const inputTokenCount = inputTokens.length;

  if (inputTokenCount === 1) {
    // Single meaningful token — check if it appears in candidate
    if (candidate.includes(inputTokens[0])) scores.push(0.7);
    // Also check vowel-stripped
    const strippedInput = removeLatinVowels(inputTokens[0]);
    const strippedCandidate = removeLatinVowels(candidate);
    if (strippedCandidate.includes(strippedInput) && strippedInput.length > 2) {
      scores.push(0.65);
    }
  }

  return Math.max(...scores);
}

// ── List Screening ────────────────────────────────────────────

/**
 * Screen a name against a sanctions list.
 * Checks: primary name (Latin), aliases (Latin + Arabic)
 */
function screenAgainstList(fullName, list, listName, threshold = 0.60) {
  const normalizedInput = normalizeLatin(fullName);
  const normalizedArabicInput = normalizeArabic(fullName);
  const isArabicInput = /[\u0600-\u06FF]/.test(fullName);

  let bestMatch = null;
  let bestScore = 0;

  for (const entry of list) {
    const candidates = [];

    // Primary name (Latin transliteration)
    if (entry.name) candidates.push({ text: normalizeLatin(entry.name), source: "name" });

    // Arabic name — match directly if input is Arabic
    if (entry.name_arabic) {
      if (isArabicInput) {
        const arabicScore = tokenSimilarity(
          normalizeArabic(fullName),
          normalizeArabic(entry.name_arabic)
        );
        if (arabicScore > bestScore) {
          bestScore = arabicScore;
          bestMatch = { ...entry, list: listName, score: arabicScore, matchedOn: "arabic_name" };
        }
      }
      // Also add transliteration of arabic as a candidate
      candidates.push({ text: normalizeLatin(entry.name_arabic.replace(/[\u0600-\u06FF]/g, "")), source: "arabic_transliterated" });
    }

    // Aliases
    if (entry.aliases && Array.isArray(entry.aliases)) {
      for (const alias of entry.aliases) {
        if (!alias) continue;
        if (/[\u0600-\u06FF]/.test(alias)) {
          // Arabic alias
          if (isArabicInput) {
            const arabicScore = tokenSimilarity(
              normalizeArabic(fullName),
              normalizeArabic(alias)
            );
            if (arabicScore > bestScore) {
              bestScore = arabicScore;
              bestMatch = { ...entry, list: listName, score: arabicScore, matchedAlias: alias, matchedOn: "arabic_alias" };
            }
          }
        } else {
          candidates.push({ text: normalizeLatin(alias), source: "alias" });
        }
      }
    }

    // Score all Latin candidates
    for (const candidate of candidates) {
      if (!candidate.text) continue;
      const score = compositeScore(normalizedInput, candidate.text);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = {
          ...entry,
          list: listName,
          score,
          matchedOn: candidate.source,
          matchedAlias: candidate.source !== "name" ? candidate.text : undefined
        };
      }
    }
  }

  return bestScore >= threshold ? { ...bestMatch, score: bestScore } : null;
}

// ── Fulfillment & Order Helpers ───────────────────────────────

async function addFulfillmentHold(shopDomain, accessToken, orderId, reason) {
  const getFulfillmentOrderQuery = `
    query getFulfillmentOrders($orderId: ID!) {
      order(id: $orderId) {
        fulfillmentOrders(first: 5) {
          nodes { id status }
        }
      }
    }
  `;
  const foResponse = await fetch(
    `https://${shopDomain}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query: getFulfillmentOrderQuery, variables: { orderId } }),
    }
  );
  const foData = await foResponse.json();
  const fulfillmentOrders = foData?.data?.order?.fulfillmentOrders?.nodes || [];

  for (const fo of fulfillmentOrders) {
    if (fo.status === "OPEN") {
      const holdMutation = `
        mutation holdFulfillmentOrder($id: ID!, $reason: FulfillmentHoldReason!, $reasonNotes: String!) {
          fulfillmentOrderHold(id: $id, fulfillmentHold: { reason: $reason, reasonNotes: $reasonNotes }) {
            fulfillmentOrder { id status }
            userErrors { field message }
          }
        }
      `;
      await fetch(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ query: holdMutation, variables: { id: fo.id, reason: "OTHER", reasonNotes: reason } }),
      });
    }
  }
}

async function tagOrder(shopDomain, accessToken, orderId, tagsToAdd) {
  const getTagsQuery = `query getOrderTags($id: ID!) { order(id: $id) { tags } }`;
  const tagsResponse = await fetch(
    `https://${shopDomain}/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
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
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query: updateMutation, variables: { id: orderId, tags: allTags } }),
  });
}

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
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query: mutation, variables: { id: orderId, note } }),
  });
}

// ── Main Handler ──────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const sharedSecret = process.env.FLOW_SHARED_SECRET;
  const incomingSecret = req.headers["x-kyc-secret"];
  if (!sharedSecret || incomingSecret !== sharedSecret) {
    console.error("Unauthorized request");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { order_id, order_name, customer_first_name, customer_last_name, shop_domain } = req.body;

  if (!order_id || !customer_first_name || !customer_last_name) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const fullName = `${customer_first_name} ${customer_last_name}`.trim();
  const shopDomain = shop_domain || process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  console.log(`[KYC v2] Screening: "${fullName}" for order ${order_name || order_id}`);

  try {
    const unMatch = screenAgainstList(fullName, UN_LIST, "UN Consolidated List");
    const mofaMatch = screenAgainstList(fullName, MOFA_LIST, "Kuwait MOFA National List");

    const isMatch = unMatch !== null || mofaMatch !== null;
    const matches = [unMatch, mofaMatch].filter(Boolean);

    if (isMatch) {
      console.warn(`[KYC v2] MATCH FOUND for "${fullName}":`, matches);

      const matchSummary = matches
        .map(m => `${m.list}: "${m.matchedAlias || m.name}" (score: ${(m.score * 100).toFixed(0)}%, matched on: ${m.matchedOn || "name"})`)
        .join("; ");

      const noteText = `⚠️ KYC ALERT — Sanctions screening flagged this order for manual review.\nCustomer name: "${fullName}"\nMatches: ${matchSummary}\nScreened at: ${new Date().toISOString()}\nAction required: Do not fulfill until compliance review is complete.`;

      if (accessToken) {
        await tagOrder(shopDomain, accessToken, order_id, ["kyc-review", "sanctions-flag"]);
        await addFulfillmentHold(shopDomain, accessToken, order_id, `KYC sanctions screening flagged this order. Matches: ${matchSummary}`);
        await addOrderNote(shopDomain, accessToken, order_id, noteText);
      }

      return res.status(200).json({ result: "flagged", order: order_name, customer: fullName, matches: matchSummary });

    } else {
      console.log(`[KYC v2] Clear: "${fullName}" — no matches found.`);

      if (accessToken) {
        await tagOrder(shopDomain, accessToken, order_id, ["kyc-cleared"]);
      }

      return res.status(200).json({ result: "cleared", order: order_name, customer: fullName });
    }

  } catch (err) {
    console.error("[KYC v2] Error during screening:", err);
    return res.status(500).json({ error: "Internal screening error" });
  }
};
