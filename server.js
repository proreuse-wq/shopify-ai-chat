import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

async function searchShopifyProducts(query) {
  const response = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/2023-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      },
      body: JSON.stringify({
        query: `
        query ($search: String!) {
          products(first: 4, query: $search) {
            edges {
              node {
                title
                handle
                images(first: 1) {
                  edges {
                    node {
                      url
                    }
                  }
                }
                variants(first: 1) {
                  edges {
                    node {
                      price
                    }
                  }
                }
              }
            }
          }
        }
        `,
        variables: {
          search: query,
        },
      }),
    }
  );

  const json = await response.json();

  return json.data.products.edges.map((edge) => {
    const p = edge.node;
    return {
      title: p.title,
      handle: p.handle,
      image: p.images.edges[0]?.node.url || "",
      price: p.variants.edges[0]?.node.price || "",
    };
  });
}

app.post("/chat", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Messaggio mancante" });
    }

    // 🔍 Estrazione keyword intelligente
    const keywordResponse = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        {
          role: "system",
          content: `
Trasforma la richiesta cliente in parole chiave per un ecommerce di cere per candele.

Regole:
- massimo 2-5 parole
- niente frasi
- se è in inglese/francese puoi tradurre in italiano
- usa termini tipo: cera soia, stoppini, contenitori, paraffina, fragranze
- se è solo un saluto scrivi: generico
`
        },
        {
          role: "user",
          content: message
        }
      ]
    });

    const searchQuery = (keywordResponse.output_text || message).trim();

    let products = [];
    if (searchQuery.toLowerCase() !== "generico") {
      products = await searchShopifyProducts(searchQuery);
    }

    // 🤖 Risposta AI
    const response = await client.responses.create({
      model: "gpt-5-mini",
      input: [
        {
          role: "system",
          content: `
Sei Mr Candelx, assistente ecommerce.

Regole:
- rispondi nella lingua del cliente
- breve e chiaro
- massimo 2-3 prodotti
- non inventare prodotti
- se non trovi nulla, dillo chiaramente
`
        },
        {
          role: "user",
          content: `
Messaggio: ${message}

Prodotti:
${JSON.stringify(products, null, 2)}
`
        }
      ]
    });

    res.json({
      reply: response.output_text || "Nessuna risposta",
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server avviato su porta", PORT);
});