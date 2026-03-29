const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const express = require("express");
const fs = require("fs");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const app = express();

require("dotenv").config();

console.log(process.env.EMAIL);
console.log(process.env.PASSWORD);

app.use(bodyParser.json());
app.use(express.static("public"));

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

const FILE = "reservations.json";

// créer fichier si pas existant
if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, "[]");
}

function cleanOldReservations() {
    let data = JSON.parse(fs.readFileSync(FILE));
    const now = new Date();

    const filtered = data.filter(resa => {

        if (resa.status === "en attente") return true;

        if (resa.status === "refusé") {
            if (!resa.refusedAt) return true;

            const limit = new Date(resa.refusedAt);
            limit.setDate(limit.getDate() + 7);

            return now < limit;
        }

        if (resa.status === "validé") {
            const sessionDateTime = new Date(`${resa.sessionDate} ${resa.sessionTime}`);

            const limit = new Date(sessionDateTime);
            limit.setDate(limit.getDate() + 7);

            return now < limit;
        }

        return true;
    });

    fs.writeFileSync(FILE, JSON.stringify(filtered, null, 2));
}

// 📥 créer réservation
app.post("/api/reserver", (req, res) => {
    const data = JSON.parse(fs.readFileSync(FILE));

    const newResa = {
        id: Date.now(),
        status: "en attente",
        ...req.body
    };

    data.push(newResa);
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

    res.send("Réservation enregistrée");
});

// 🖥️ voir réservations
app.get("/api/admin", (req, res) => {
    const data = JSON.parse(fs.readFileSync(FILE));
    res.json(data);
});

// 📩 valider + envoyer ticket PDF
app.post("/api/valider", async (req, res) => {
    try {
        const { id } = req.body;

        let data = JSON.parse(fs.readFileSync(FILE));
        const resa = data.find(r => r.id == id);

        if (!resa) {
            return res.status(404).send("Réservation introuvable");
        }

        const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
        const qrData = `${BASE_URL}/verify?id=${resa.id}`;
        const qrCodeBase64 = await QRCode.toDataURL(qrData);

        const html = `
<div style="
  width:280px;
  font-family:Arial;
  border:2px dashed black;
  padding:20px;
  text-align:center;
  background:#fff;
">
  <h2 style="margin:0;">🎬 CINEPOP</h2>
  <hr>

  <h1 style="margin:10px 0;">${resa.filmTitle}</h1>

  <p><b>Salle :</b> ${resa.roomNumber}</p>
  <p><b>Date :</b> ${resa.sessionDate}</p>
  <p><b>Heure :</b> ${resa.sessionTime}</p>

  <p><b>Client :</b> ${resa.clientName}</p>
  <p><b>Places :</b> ${resa.peopleNumber}</p>

  <img src="${qrCodeBase64}" style="width:120px;margin:10px auto;" />

  <p style="font-size:12px;">Ticket #${resa.id}</p>

  <div style="
    margin-top:10px;
    font-size:12px;
    opacity:0.6;
  ">
    Présentez ce QR code à l’entrée
  </div>
</div>
`;

        const chromium = require("@sparticuz/chromium");
        const puppeteer = require("puppeteer-core");

        const browser = await puppeteer.launch({
            args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        await page.setContent(html);

        const buffer = await page.pdf({ format: "A6" });

        await browser.close();

        let transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL,
                pass: process.env.PASSWORD
            }
        });

        await transporter.sendMail({
            from: "cinema@test.com",
            to: resa.email,
            subject: "🎟️ Votre billet CinéPop",
            text: `Bonjour ${resa.clientName},

Votre réservation pour "${resa.filmTitle}" est confirmée 🎬

📅 ${resa.sessionDate} à ${resa.sessionTime}
🎟️ ${resa.peopleNumber} place(s)

Votre billet est en pièce jointe.

Bon film 🍿
CinéPop`,
            attachments: [
                {
                    filename: `ticket-${resa.id}.pdf`,
                    content: buffer
                }
            ]
        });

        resa.status = "validé";
        resa.validatedAt = new Date();

        fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

        res.send("Ticket envoyé !");
    } catch (err) {
        console.error(err);
        res.status(500).send("Erreur serveur");
    }
});

app.get("/verify", (req, res) => {
    const id = req.query.id;

    const data = JSON.parse(fs.readFileSync(FILE));
    const resa = data.find(r => r.id == id);

    if (!resa) {
        return res.send("<h1>❌ Ticket invalide</h1>");
    }

    if (resa.status !== "validé") {
        return res.send("<h1>⏳ Ticket non validé</h1>");
    }

    const now = new Date();
    const sessionDateTime = new Date(`${resa.sessionDate} ${resa.sessionTime}`);

    const startWindow = new Date(sessionDateTime);
    startWindow.setMinutes(startWindow.getMinutes() - 30);

    const endWindow = new Date(sessionDateTime);
    endWindow.setMinutes(endWindow.getMinutes() + 5);

    if (now < startWindow || now > endWindow) {
        return res.send("<h1>⛔ Ticket hors créneau</h1>");
    }

    res.send(`
        <h1>✅ Ticket VALIDE</h1>
        <p>Client : ${resa.clientName}</p>
        <p>Nombre : ${resa.peopleNumber}</p>
        <p>Film : ${resa.filmTitle}</p>
        <p>Salle : ${resa.roomNumber}</p>
    `);
});

app.post("/api/refuser", async (req, res) => {
    try {
        const { id } = req.body;

        let data = JSON.parse(fs.readFileSync(FILE));
        const resa = data.find(r => r.id == id);

        if (!resa) {
            return res.status(404).send("Réservation introuvable");
        }

        let transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL,
                pass: process.env.PASSWORD
            }
        });

        await transporter.sendMail({
            from: "cinema@test.com",
            to: resa.email,
            subject: "❌ Réservation refusée",
            text: `Bonjour ${resa.clientName},

Votre réservation pour "${resa.filmTitle}" le ${resa.sessionDate} à ${resa.sessionTime} n'a malheureusement pas pu être acceptée.Tentez votre chance une prochaine fois !

Merci de votre compréhension.

🎬 CinéPop`
        });

        resa.status = "refusé";
        resa.refusedAt = new Date();

        fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

        res.send("Réservation refusée");
    } catch (err) {
        console.error(err);
        res.status(500).send("Erreur serveur");
    }
});

setInterval(() => {
    cleanOldReservations();
    console.log("🧹 Nettoyage des réservations...");
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Serveur lancé sur le port " + PORT);
});