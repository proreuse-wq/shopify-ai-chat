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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

let shopifyToken = null;
let shopifyTokenExpiresAt = 0;

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
    const cleanDescription = (node.description || "").replace(/\s+/g, " ").trim();

    return {
      title: node.title,
      handle: node.handle,
      description: cleanDescription.slice(0, 220),
      status: node.status,
      url: node.onlineStoreUrl || `https://eshop-candelx.com/products/${node.handle}`,
      image: node.featuredImage?.url || "",
      imageAlt: node.featuredImage?.altText || node.title,
      variantId: firstVariant?.legacyResourceId ? String(firstVariant.legacyResourceId) : "",
      price: firstVariant?.price || "",
      variantTitle: firstVariant?.title || ""
    };
  });
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

    const keywordResponse = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        {
          role: "system",
          content: `
Sei un assistente che trasforma una richiesta cliente in parole chiave utili per cercare prodotti in un ecommerce di cere e materiali per candele.

Regole:
- restituisci solo una riga
- massimo 2-5 parole chiave
- niente frasi complete
- se il cliente scrive in inglese o francese, puoi convertire la ricerca in termini italiani se questo aiuta a trovare prodotti del catalogo
- privilegia termini concreti come: cera di soia, contenitori, stoppini, paraffina, gel, fragranze, stampi, bicchieri
- se il messaggio è solo un saluto o è troppo generico, restituisci esattamente: generico
`
        },
        {
          role: "user",
          content: cleanedMessage
        }
      ]
    });

    const searchQuery = (keywordResponse.output_text || cleanedMessage).trim();

    let products = [];
    if (searchQuery.toLowerCase() !== "generico") {
      products = await searchShopifyProducts(searchQuery);
    }

    const response = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        {
          role: "system",
          content: `
Sei Mr Candelx, assistente clienti di eshop-candelx.com.

OBIETTIVO:
aiutare il cliente a scegliere velocemente e portarlo verso i prodotti giusti.

REGOLE:
- rispondi nella stessa lingua del cliente
- usa SOLO i prodotti forniti se pertinenti
- non inventare prodotti, prezzi o disponibilità
- se non trovi prodotti pertinenti, dillo chiaramente
- rispondi in modo breve, chiaro e commerciale
- evita testi troppo lunghi
- proponi al massimo 2 o 3 prodotti
- non fare troppe domande
- se serve, fai una sola domanda finale breve

FORMATO:
- una frase iniziale breve
- elenco sintetico dei prodotti consigliati, se presenti
- una chiusura breve con invito all'azione

IMPORTANTE:
- non scrivere URL lunghi nel testo se non necessario
- i prodotti verranno mostrati anche separatamente sotto la risposta
`
        },
        {
          role: "user",
          content: `
Domanda cliente:
${cleanedMessage}

Query di ricerca usata:
${searchQuery}

Prodotti trovati nel negozio:
${JSON.stringify(products, null, 2)}
`
        }
      ]
    });

    const reply = response.output_text || "Nessuna risposta generata.";

    await saveChatMessage({
      sessionId: safeSessionId,
      role: "user",
      message: cleanedMessage,
      pageUrl: safePageUrl,
      searchQuery
    });

    await saveChatMessage({
      sessionId: safeSessionId,
      role: "assistant",
      message: reply,
      pageUrl: safePageUrl,
      searchQuery
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