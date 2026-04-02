import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { URLSearchParams } from "url";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

let shopifyToken = null;
let shopifyTokenExpiresAt = 0;

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
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Errore token Shopify: ${response.status} - ${text}`);
  }

  const data = await response.json();
  shopifyToken = data.access_token;
  shopifyTokenExpiresAt = Date.now() + data.expires_in * 1000;

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
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
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
      products(first: 5, query: $search) {
        edges {
          node {
            id
            title
            handle
            description
            status
            onlineStoreUrl
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, {
    search: searchText,
  });

  return data.products.edges.map(({ node }) => ({
    title: node.title,
    handle: node.handle,
    description: node.description,
    status: node.status,
    url: node.onlineStoreUrl || `https://eshop-candelx.com/products/${node.handle}`,
  }));
}

app.get("/", (req, res) => {
  res.sendFile(new URL("./public/index.html", import.meta.url).pathname);
});

app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Messaggio mancante" });
    }

    const products = await searchShopifyProducts(message);

    const response = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        {
          role: "system",
          content: `
Sei Mr Candelx, assistente clienti di eshop-candelx.com.

OBIETTIVO:
vendere e aiutare il cliente a scegliere velocemente.

REGOLE:
- usa SOLO i prodotti forniti se pertinenti
- non inventare prodotti o prezzi
- non inventare disponibilità
- rispondi in modo breve e chiaro
- evita spiegazioni lunghe
- proponi direttamente 2 o 3 prodotti con breve descrizione
- usa tono commerciale ma naturale
- non fare troppe domande
- se necessario fai al massimo 1 domanda finale
- invita sempre a cliccare il prodotto o aggiungerlo al carrello

FORMATO:
- breve introduzione
- elenco prodotti consigliati (max 3)
- eventuale consiglio rapido finale
`,
        },
        {
          role: "user",
          content: `
Domanda cliente:
${message}

Prodotti trovati nel negozio:
${JSON.stringify(products, null, 2)}
`,
        },
      ],
    });

    res.json({
      reply: response.output_text || "Nessuna risposta generata.",
      products,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Errore server",
      details: error.message,
    });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Server attivo sulla porta ${process.env.PORT || 3000}`);
});