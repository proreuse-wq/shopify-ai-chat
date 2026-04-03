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
const SUPPORT_EMAIL = "candelx@eshop-candelx.com";

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
      customer_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS customer_email TEXT
  `);
}

async function saveChatMessage({
  sessionId,
  role,
  message,
  pageUrl = null,
  searchQuery = null,
  customerEmail = null
}) {
  await pool.query(
    `
    INSERT INTO chat_messages (session_id, role, message, page_url, search_query, customer_email)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [sessionId, role, message, pageUrl, searchQuery, customerEmail]
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

function extractEmail(text) {
  const match = String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : null;
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
- Se la richiesta riguarda ordine, supporto umano, problemi specifici, prezzi contestati, disponibilità reale o assistenza, classificala come shipping_returns_service o other e NON puntare sulla ricerca prodotti.
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
      SELECT id, session_id, role, message, page_url, search_query, customer_email, created_at
      FROM chat_messages
      ORDER BY created_at DESC
      LIMIT 500
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

app.get("/admin/chats/sessions", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        session_id,
        MAX(customer_email) FILTER (WHERE customer_email IS NOT NULL AND customer_email <> '') AS customer_email,
        MIN(created_at) AS started_at,
        MAX(created_at) AS last_message_at,
        COUNT(*) AS total_messages,
        MAX(page_url) FILTER (WHERE page_url IS NOT NULL AND page_url <> '') AS last_page_url
      FROM chat_messages
      GROUP BY session_id
      ORDER BY last_message_at DESC
      LIMIT 200
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Errore lettura sessioni",
      details: error.message
    });
  }
});

app.get("/admin/chats/session/:sessionId", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, session_id, role, message, page_url, search_query, customer_email, created_at
      FROM chat_messages
      WHERE session_id = $1
      ORDER BY created_at ASC
      `,
      [req.params.sessionId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Errore lettura sessione",
      details: error.message
    });
  }
});

app.get("/admin/inbox", async (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8" />
  <title>Chat Inbox</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #f5f5f5; }
    .layout { display: grid; grid-template-columns: 360px 1fr; height: 100vh; }
    .sidebar { border-right: 1px solid #ddd; background: #fff; overflow-y: auto; }
    .content { padding: 20px; overflow-y: auto; }
    .session { padding: 14px 16px; border-bottom: 1px solid #eee; cursor: pointer; }
    .session:hover { background: #f7f7f7; }
    .session.active { background: #eef7f0; }
    .email { font-weight: 700; color: #157A3A; margin-bottom: 4px; }
    .meta { font-size: 12px; color: #666; }
    .msg { margin-bottom: 12px; display: flex; }
    .msg.user { justify-content: flex-end; }
    .msg.assistant { justify-content: flex-start; }
    .bubble { max-width: 70%; padding: 10px 12px; border-radius: 12px; line-height: 1.4; white-space: pre-wrap; }
    .user .bubble { background: #e6f4ea; }
    .assistant .bubble { background: #fff; border: 1px solid #ddd; }
    .topbar { margin-bottom: 16px; }
    .muted { color: #666; font-size: 13px; }
    a { color: #157A3A; }
  </style>
</head>
<body>
  <div class="layout">
    <div class="sidebar" id="sessions"></div>
    <div class="content">
      <div class="topbar">
        <h2 style="margin:0 0 8px;">Inbox chat</h2>
        <div class="muted" id="sessionMeta">Seleziona una sessione a sinistra.</div>
      </div>
      <div id="messages"></div>
    </div>
  </div>

  <script>
    const sessionsEl = document.getElementById("sessions");
    const messagesEl = document.getElementById("messages");
    const sessionMetaEl = document.getElementById("sessionMeta");
    let activeSessionId = null;

    function esc(text) {
      return String(text || "").replace(/[&<>"]/g, (m) => ({
        "&":"&amp;",
        "<":"&lt;",
        ">":"&gt;",
        '"':"&quot;"
      }[m]));
    }

    async function loadSessions() {
      const res = await fetch("/admin/chats/sessions");
      const sessions = await res.json();

      sessionsEl.innerHTML = sessions.map((s) => {
        return \`
          <div class="session \${activeSessionId === s.session_id ? "active" : ""}" data-session-id="\${esc(s.session_id)}">
            <div class="email">\${esc(s.customer_email || "Email non disponibile")}</div>
            <div class="meta">Sessione: \${esc(s.session_id)}</div>
            <div class="meta">Messaggi: \${esc(s.total_messages)}</div>
            <div class="meta">Ultima attività: \${esc(s.last_message_at)}</div>
          </div>
        \`;
      }).join("");

      sessionsEl.querySelectorAll(".session").forEach((el) => {
        el.addEventListener("click", async () => {
          activeSessionId = el.getAttribute("data-session-id");
          await loadSessions();
          await loadSession(activeSessionId);
        });
      });
    }

    async function loadSession(sessionId) {
      const res = await fetch("/admin/chats/session/" + encodeURIComponent(sessionId));
      const rows = await res.json();

      if (!rows.length) {
        messagesEl.innerHTML = "<p>Nessun messaggio.</p>";
        sessionMetaEl.textContent = "Nessun dettaglio disponibile.";
        return;
      }

      const email = rows.find((r) => r.customer_email)?.customer_email || "Email non disponibile";
      const page = rows[rows.length - 1].page_url || "";
      sessionMetaEl.innerHTML = \`
        <strong>Email:</strong> \${esc(email)}<br>
        <strong>Sessione:</strong> \${esc(sessionId)}<br>
        <strong>Ultima pagina:</strong> \${page ? '<a href="' + esc(page) + '" target="_blank" rel="noopener noreferrer">' + esc(page) + '</a>' : 'n/d'}
      \`;

      messagesEl.innerHTML = rows.map((row) => {
        return \`
          <div class="msg \${esc(row.role)}">
            <div class="bubble">
              <div style="font-size:12px; color:#666; margin-bottom:4px;">
                \${esc(row.role)} · \${esc(row.created_at)}
              </div>
              \${esc(row.message)}
            </div>
          </div>
        \`;
      }).join("");
    }

    loadSessions();
  </script>
</body>
</html>
  `);
});

app.post("/chat", async (req, res) => {
  try {
    const { message, sessionId, pageUrl, customerEmail } = req.body;

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

    const extractedEmail = extractEmail(cleanedMessage);
    const safeCustomerEmail =
      extractedEmail ||
      (typeof customerEmail === "string" && customerEmail.trim() ? customerEmail.trim() : null);

    const lowerMessage = cleanedMessage.toLowerCase();

    const humanSupportPatterns = [
      "operatore",
      "persona",
      "umano",
      "richiam",
      "chiamami",
      "chiamatemi",
      "telefono",
      "numero ordine",
      "ordine",
      "supporto",
      "assistenza",
      "prezzo aumentato",
      "prezzo cambiato",
      "magazzino",
      "disponibil",
      "stock",
      "live chat",
      "whatsapp",
      "problema",
      "reclamo",
      "errore ordine",
      "modifica ordine"
    ];

    if (extractedEmail) {
      const emailReply = `Perfetto, ho registrato la tua email: ${extractedEmail}. Dimmi pure come posso aiutarti.`;

      await saveChatMessage({
        sessionId: safeSessionId,
        role: "user",
        message: cleanedMessage,
        pageUrl: safePageUrl,
        searchQuery: null,
        customerEmail: safeCustomerEmail
      });

      await saveChatMessage({
        sessionId: safeSessionId,
        role: "assistant",
        message: emailReply,
        pageUrl: safePageUrl,
        searchQuery: null,
        customerEmail: safeCustomerEmail
      });

      return res.json({
        reply: emailReply,
        products: [],
        customerEmail: safeCustomerEmail
      });
    }

    if (!safeCustomerEmail) {
      const askEmailReply = `Prima di continuare, puoi scrivermi la tua email? Così sappiamo con chi stiamo parlando.`;

      await saveChatMessage({
        sessionId: safeSessionId,
        role: "user",
        message: cleanedMessage,
        pageUrl: safePageUrl,
        searchQuery: null,
        customerEmail: null
      });

      await saveChatMessage({
        sessionId: safeSessionId,
        role: "assistant",
        message: askEmailReply,
        pageUrl: safePageUrl,
        searchQuery: null,
        customerEmail: null
      });

      return res.json({
        reply: askEmailReply,
        products: [],
        customerEmail: null
      });
    }

    if (humanSupportPatterns.some((pattern) => lowerMessage.includes(pattern))) {
      const safeReply = `Per questa richiesta ti chiediamo di scrivere a ${SUPPORT_EMAIL} così il nostro team può aiutarti direttamente.`;

      await saveChatMessage({
        sessionId: safeSessionId,
        role: "user",
        message: cleanedMessage,
        pageUrl: safePageUrl,
        searchQuery: null,
        customerEmail: safeCustomerEmail
      });

      await saveChatMessage({
        sessionId: safeSessionId,
        role: "assistant",
        message: safeReply,
        pageUrl: safePageUrl,
        searchQuery: null,
        customerEmail: safeCustomerEmail
      });

      return res.json({
        reply: safeReply,
        products: [],
        customerEmail: safeCustomerEmail
      });
    }

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

        const queryWords = normalizeText(query).toLowerCase().split(/\s+/).filter(Boolean);

        products = products.filter((product) => {
          const haystack = normalizeText(
            `${product.title} ${product.description} ${product.handle}`
          ).toLowerCase();

          return queryWords.length === 0 || queryWords.some((word) => haystack.includes(word));
        });
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

MODALITÀ PROTETTA:
Il tuo obiettivo è aiutare il cliente senza creare confusione, senza promettere azioni che non puoi eseguire e senza dare informazioni non confermate.

TONO:
- naturale
- umano
- professionale
- breve e chiaro
- non robotico

COSA PUOI FARE:
- dare orientamento sui prodotti
- spiegare differenze generali tra materiali e usi
- usare le informazioni del sito fornite nel contesto
- suggerire prodotti SOLO se i prodotti trovati sono chiaramente pertinenti

COSA NON DEVI MAI FARE:
- non dire mai che aggiungi prodotti al carrello
- non dire mai che controlli il magazzino
- non dire mai che richiami il cliente
- non dire mai che inoltri a un operatore
- non dire mai che modifichi ordini o prenoti chat/chiamate
- non dire mai che verifichi disponibilità reale, stock, tempi specifici o prezzi futuri se non confermati chiaramente
- non promettere azioni interne dell’azienda
- non inventare prodotti, prezzi, disponibilità, policy o servizi

REGOLE IMPORTANTI:
- rispondi nella stessa lingua del cliente
- se la richiesta è su ordini, disponibilità reale, contestazioni di prezzo, supporto umano, richieste commerciali delicate o problemi post-vendita, NON improvvisare
- in quei casi indirizza il cliente a scrivere a ${SUPPORT_EMAIL}
- se la richiesta è vaga, fai al massimo UNA domanda chiarificatrice
- se la domanda è tecnica, spiega bene prima di proporre prodotti
- se la domanda è su spedizioni, resi, policy, usa il contesto del sito
- usa SOLO i prodotti forniti se davvero pertinenti
- se non hai certezza, dillo in modo semplice e invita a scrivere a ${SUPPORT_EMAIL}
- non scrivere URL lunghi nel testo se non necessario
- se proponi prodotti, massimo 2 o 3
- se i prodotti trovati sono vuoti o poco pertinenti, non proporre articoli specifici come alternativa certa
- non dire "abbiamo" o "dal catalogo vedo" se i prodotti trovati non lo confermano chiaramente
- se la richiesta riguarda una categoria generica e il catalogo non conferma risultati affidabili, dai prima un orientamento generale e poi fai una sola domanda breve
- non trasformare consigli tecnici generali in disponibilità di catalogo
- non suggerire additivi, miscele o ingredienti specifici come prodotti disponibili se non compaiono tra i prodotti trovati

STILE RISPOSTA:
- evita elenchi troppo meccanici
- niente risposte troppo lunghe
- niente interrogatori
- se puoi aiutare subito, aiuta subito
- se non puoi aiutare bene, dillo chiaramente e invita a scrivere a ${SUPPORT_EMAIL}
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

Email supporto da usare se serve:
${SUPPORT_EMAIL}

Email cliente:
${safeCustomerEmail}
`
          }
        ]
      });

      reply = response.output_text || `Per questa richiesta ti chiediamo di scrivere a ${SUPPORT_EMAIL}.`;
    }

    await saveChatMessage({
      sessionId: safeSessionId,
      role: "user",
      message: cleanedMessage,
      pageUrl: safePageUrl,
      searchQuery: analysis.search_query || null,
      customerEmail: safeCustomerEmail
    });

    await saveChatMessage({
      sessionId: safeSessionId,
      role: "assistant",
      message: reply,
      pageUrl: safePageUrl,
      searchQuery: analysis.search_query || null,
      customerEmail: safeCustomerEmail
    });

    res.json({
      reply,
      products,
      customerEmail: safeCustomerEmail
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