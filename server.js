import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import pg from "pg";

dotenv.config();

const { Pool } = pg;

const app = express();

app.use(
  cors({
    origin: [
      "https://eshop-candelx.com",
      "https://www.eshop-candelx.com",
      "http://localhost:3000"
    ]
  })
);

app.use(express.json());
app.use(express.static("public"));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SITE_BASE = "https://eshop-candelx.com";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

let shopifyToken = null;
let shopifyTokenExpiresAt = 0;

let siteCache = {
  updatedAt: 0,
  entries: []
};

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      page_url TEXT,
      search_query TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function saveChatMessage({
  sessionId,
  role,
  message,
  pageUrl = null,
  searchQuery = null
}) {
  await pool.query(
    `
    INSERT INTO chat_messages (session_id, role, message, page_url, search_query)
    VALUES ($1, $2, $3, $4, $5)
    `,
    [sessionId, role, message, pageUrl, searchQuery]
  );
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(html) {
  return normalizeText(
    decodeHtmlEntities(
      String(html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

function parseXmlLocs(xml) {
  const matches = [...String(xml || "").matchAll(/<loc>(.*?)<\/loc>/gi)];
  return matches.map((m) => decodeHtmlEntities(m[1].trim()));
}

async function fetchUrlText(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 Chat Assistant"
      }
    });

    if (!response.ok) return null;

    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    const title = normalizeText(decodeHtmlEntities(titleMatch?.[1] || ""));
    const text = stripHtml(html).slice(0, 6000);

    return {
      url,
      title,
      text
    };
  } catch {
    return null;
  }
}

function keywordSet(text) {
  return new Set(
    normalizeText(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3)
  );
}

function scoreEntry(question, entry) {
  const q = keywordSet(question);
  const hay = normalizeText(`${entry.title} ${entry.url} ${entry.text}`).toLowerCase();

  let score = 0;
  for (const word of q) {
    if (hay.includes(word)) score += 2;
  }

  if (/spedizion|shipping|delivery|resi|returns|refund|privacy|policy|faq|azienda|company|blog/i.test(entry.url)) {
    score += 1;
  }

  return score;
}

async function refreshSiteCache() {
  const now = Date.now();
  if (siteCache.entries.length > 0 && now - siteCache.updatedAt < 60 * 60 * 1000) {
    return siteCache.entries;
  }

  const sitemapResponse = await fetch(`${SITE_BASE}/sitemap.xml`);
  if (!sitemapResponse.ok) {
    throw new Error(`Impossibile leggere sitemap: ${sitemapResponse.status}`);
  }

  const sitemapXml = await sitemapResponse.text();
  const sitemapUrls = parseXmlLocs(sitemapXml);

  const relevantSitemaps = sitemapUrls.filter((url) =>
    /sitemap_(pages|blogs|collections)/i.test(url)
  );

  let pageUrls = [];
  for (const submap of relevantSitemaps) {
    try {
      const res = await fetch(submap);
      if (!res.ok) continue;
      const xml = await res.text();
      pageUrls.push(...parseXmlLocs(xml));
    } catch {
      // ignore
    }
  }

  pageUrls = [...new Set(pageUrls)]
    .filter((url) => url.startsWith(SITE_BASE))
    .slice(0, 40);

  const entries = [];
  for (const url of pageUrls) {
    const entry = await fetchUrlText(url);
    if (entry && entry.text) {
      entries.push(entry);
    }
  }

  siteCache = {
    updatedAt: now,
    entries
  };

  return entries;
}

async function getRelevantSiteContext(question) {
  const entries = await refreshSiteCache();
  if (!entries.length) return [];

  const scored = entries
    .map((entry) => ({
      ...entry,
      score: scoreEntry(question, entry)
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return scored.map((entry) => ({
    url: entry.url,
    title: entry.title,
    snippet: entry.text.slice(0, 900)
  }));
}

async function getShopifyToken() {
  if (shopifyToken && Date.now() < shopifyTokenExpiresAt - 60000) {
    return shopifyToken;
  }

  const response = await fetch(
    `https://${SHOP}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json"
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Errore token Shopify: ${response.status} - ${text}`);
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error("Token Shopify non ricevuto");
  }

  shopifyToken = data.access_token;
  shopifyTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;

  return shopifyToken;
}

async function shopifyGraphQL(query, variables = {}) {
  const token = await getShopifyToken();

  const response = await fetch(
    `https://${SHOP}.myshopify.com/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Errore GraphQL Shopify: ${response.status} - ${JSON.stringify(data)}`
    );
  }

  if (data.errors) {
    throw new Error(`Errori GraphQL Shopify: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

async function searchShopifyProducts(searchText) {
  const query = `
    query SearchProducts($search: String!) {
      products(first: 4, query: $search) {
        edges {
          node {
            id
            title
            handle
            description
            status
            onlineStoreUrl
            featuredImage {
              url
              altText
            }
            variants(first: 1) {
              edges {
                node {
                  id
                  title
                  price
                  legacyResourceId
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, {
    search: searchText
  });

  return data.products.edges.map(({ node }) => {
    const firstVariant = node.variants.edges[0]?.node || null;
    const cleanDescription = normalizeText(node.description || "");

    return {
      title: node.title,
      handle: node.handle,
      description: cleanDescription.slice(0, 220),
      status: node.status,
      url: node.onlineStoreUrl || `${SITE_BASE}/products/${node.handle}`,
      image: node.featuredImage?.url || "",
      imageAlt: node.featuredImage?.altText || node.title,
      variantId: firstVariant?.legacyResourceId ? String(firstVariant.legacyResourceId) : "",
      price: firstVariant?.price || "",
      variantTitle: firstVariant?.title || ""
    };
  });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function classifyMessage(message) {
  const response = await client.responses.create({
    model: "gpt-5-mini",
    input: [
      {
        role: "system",
        content: `
Classifica il messaggio di un cliente ecommerce in JSON puro.

Restituisci SOLO JSON valido con queste chiavi:
{
  "intent": "greeting|generic_product_request|specific_product_request|technical_question|shipping_returns_service|b2b_request|other",
  "reply_language": "it|en|fr|other",
  "needs_product_search": true,
  "needs_site_context": true,
  "needs_clarification": false,
  "clarifying_question": "",
  "search_query": ""
}

Regole:
- Se il messaggio è un semplice saluto, usa intent="greeting", needs_product_search=false, needs_clarification=false.
- Se il messaggio parla di spedizione, resi, pagamenti, azienda, policy, usa needs_site_context=true.
- Se il messaggio è tecnico su cere, stoppini, utilizzo, differenze, usa needs_site_context=true.
- Se il messaggio è un prodotto chiaro o abbastanza interpretabile, NON chiedere chiarimenti: prova a cercare prodotti.
- Usa needs_clarification=true SOLO se manca un'informazione davvero indispensabile per rispondere bene.
- Non fare più di una domanda chiarificatrice.
- Se il cliente scrive in inglese o francese, puoi trasformare search_query in termini italiani se questo aiuta a cercare nel catalogo.
- search_query deve essere breve, 2-5 parole, oppure stringa vuota.
- Per richieste tipo "cera per contenitori", "cera di soia", "stoppini", "fragranze", "bicchieri", prova prima la ricerca e NON chiedere chiarimenti.
`
      },
      {
        role: "user",
        content: message
      }
    ]
  });

  const parsed = safeJsonParse(response.output_text || "");
  if (parsed) return parsed;

  return {
    intent: "other",
    reply_language: "it",
    needs_product_search: false,
    needs_site_context: false,
    needs_clarification: false,
    clarifying_question: "",
    search_query: ""
  };
}

app.get("/", (req, res) => {
  res.sendFile(new URL("./public/index.html", import.meta.url).pathname);
});

app.get("/admin/chats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, session_id, role, message, page_url, search_query, created_at
      FROM chat_messages
      ORDER BY created_at DESC
      LIMIT 300
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Errore lettura chat",
      details: error.message
    });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const { message, sessionId, pageUrl } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Messaggio mancante" });
    }

    const cleanedMessage = message.trim();

    const safeSessionId =
      typeof sessionId === "string" && sessionId.trim()
        ? sessionId.trim()
        : `anon_${Date.now()}`;

    const safePageUrl =
      typeof pageUrl === "string" && pageUrl.trim()
        ? pageUrl.trim()
        : null;

    const analysis = await classifyMessage(cleanedMessage);

    let products = [];
    let siteContext = [];

    if (analysis.needs_site_context) {
      siteContext = await getRelevantSiteContext(cleanedMessage);
    }

    if (analysis.needs_product_search && !analysis.needs_clarification) {
      const query = normalizeText(analysis.search_query || "");
      if (query) {
        products = await searchShopifyProducts(query);
      }
    }

    let reply = "";

    if (
  analysis.needs_clarification &&
  analysis.clarifying_question &&
  products.length === 0
) {
  reply = analysis.clarifying_question;
} else {
      const response = await client.responses.create({
        model: "gpt-5-mini",
        input: [
          {
            role: "system",
            content: `
Sei Mr Candelx, assistente clienti di eshop-candelx.com.

PERSONALITÀ:
- naturale, umano, non robotico
- utile e chiaro
- commerciale ma non insistente

REGOLE IMPORTANTI:
- rispondi nella stessa lingua del cliente
- non cercare di vendere sempre per forza
- se la domanda è tecnica, spiega bene prima di proporre prodotti
- se la domanda è su spedizioni, resi, policy, usa il contesto del sito
- se la richiesta è vaga, fai una sola domanda chiarificatrice
- non inventare prodotti, prezzi, disponibilità, policy o tempi
- usa SOLO i prodotti forniti se davvero pertinenti
- se non hai certezza, dillo in modo semplice
- non scrivere URL lunghi nel testo se non necessario
- se proponi prodotti, massimo 2 o 3
- se i prodotti trovati sono vuoti o poco pertinenti, non proporre articoli specifici come alternativa certa
- non dire "abbiamo" o "dal catalogo vedo" se i prodotti trovati non lo confermano chiaramente
- se la richiesta riguarda una categoria generica e il catalogo non conferma risultati affidabili, dai prima un orientamento generale e poi fai una sola domanda breve
- non trasformare consigli tecnici generali in disponibilità di catalogo
- non suggerire additivi, miscele o ingredienti specifici come prodotti disponibili se non compaiono tra i prodotti trovati

STILE:
- evita elenchi troppo meccanici
- risposte naturali, concise ma utili
- se serve, chiudi con una domanda breve
`
          },
          {
            role: "user",
            content: `
Messaggio cliente:
${cleanedMessage}

Analisi intent:
${JSON.stringify(analysis, null, 2)}

Contesto sito:
${JSON.stringify(siteContext, null, 2)}

Prodotti trovati:
${JSON.stringify(products, null, 2)}
`
          }
        ]
      });

      reply = response.output_text || "Nessuna risposta generata.";
    }

    await saveChatMessage({
      sessionId: safeSessionId,
      role: "user",
      message: cleanedMessage,
      pageUrl: safePageUrl,
      searchQuery: analysis.search_query || null
    });

    await saveChatMessage({
      sessionId: safeSessionId,
      role: "assistant",
      message: reply,
      pageUrl: safePageUrl,
      searchQuery: analysis.search_query || null
    });

    res.json({
      reply,
      products
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Errore server",
      details: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server attivo sulla porta ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Errore inizializzazione database:", error);
    process.exit(1);
  });