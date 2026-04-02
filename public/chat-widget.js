document.addEventListener("DOMContentLoaded", () => {
  const bubble = document.createElement("button");
  bubble.id = "mr-candelx-bubble";
  bubble.textContent = "Chat";

  const panel = document.createElement("div");
  panel.id = "mr-candelx-panel";
  panel.innerHTML = `
    <div id="mr-candelx-header">
      <strong>Assistenza clienti</strong>
      <button id="mr-candelx-close" type="button">×</button>
    </div>
    <div id="mr-candelx-messages"></div>
    <div id="mr-candelx-typing" style="display:none;">Mr Candelx sta scrivendo...</div>
    <div id="mr-candelx-input-row">
      <input id="mr-candelx-input" type="text" placeholder="Scrivi un messaggio..." />
      <button id="mr-candelx-send" type="button">Invia</button>
    </div>
  `;

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  const messages = document.getElementById("mr-candelx-messages");
  const input = document.getElementById("mr-candelx-input");
  const send = document.getElementById("mr-candelx-send");
  const closeBtn = document.getElementById("mr-candelx-close");
  const typing = document.getElementById("mr-candelx-typing");

  function addMessage(text, who) {
    const row = document.createElement("div");
    row.className = `mr-candelx-msg ${who}`;

    const msgBubble = document.createElement("div");
    msgBubble.className = "mr-candelx-msg-bubble";
    msgBubble.textContent = text;

    row.appendChild(msgBubble);
    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
  }

  bubble.addEventListener("click", () => {
    panel.classList.toggle("open");
    if (panel.classList.contains("open") && messages.children.length === 0) {
      addMessage("Ciao, sono Mr Candelx. Posso aiutarti a scegliere i prodotti giusti.", "bot");
    }
  });

  closeBtn.addEventListener("click", () => {
    panel.classList.remove("open");
  });

  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;

    addMessage(text, "user");
    input.value = "";
    typing.style.display = "block";

    try {
      const res = await fetch("https://shopify-ai-chat-production-d71a.up.railway.app/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ message: text })
      });

      const data = await res.json();
      typing.style.display = "none";
      addMessage(data.reply || "Errore nella risposta.", "bot");
    } catch (error) {
      typing.style.display = "none";
      addMessage("Errore di collegamento al server.", "bot");
    }
  }

  send.addEventListener("click", sendMessage);

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      sendMessage();
    }
  });
});