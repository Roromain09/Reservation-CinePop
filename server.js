const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const { DateTime } = require("luxon");
const express = require("express");
const fs = require("fs");
const bodyParser = require("body-parser");
const QRCode = require("qrcode");
const nodemailer = require("nodemailer");
const { google } = require('googleapis');
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

require("dotenv").config();

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

const FILE = "reservations.json";

// Créer le fichier si inexistant
if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, "[]");
}

// --- CONFIGURATION OAUTH2 GMAIL ---
const oauth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
);

oauth2Client.setCredentials({
    refresh_token: process.env.REFRESH_TOKEN
});

// Fonction pour créer un transporteur d'e-mail à la volée
async function createTransporter() {
    try {
        const accessToken = await oauth2Client.getAccessToken();
        return nodemailer.createTransport({
            service: 'gmail',
            auth: {
                type: 'OAuth2',
                user: process.env.EMAIL, // Ton adresse Gmail
                clientId: process.env.CLIENT_ID,
                clientSecret: process.env.CLIENT_SECRET,
                refreshToken: process.env.REFRESH_TOKEN,
                accessToken: accessToken.token,
            },
        });
    } catch (err) {
        console.error("Erreur de création du transporteur email:", err);
        throw err;
    }
}

// --- LOGIQUE DE NETTOYAGE ---
function cleanOldReservations() {
    try {
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
    } catch (e) {
        console.error("Erreur nettoyage:", e);
    }
}

// --- ROUTES ---

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

// 📥 Créer réservation
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

// 🖥️ Voir réservations (Admin)
app.get("/api/admin", (req, res) => {
    const data = JSON.parse(fs.readFileSync(FILE));
    res.json(data);
});

// 📩 Valider + Envoyer ticket PDF
app.post("/api/valider", async (req, res) => {
    try {
        const { id } = req.body;
        let data = JSON.parse(fs.readFileSync(FILE));
        const resa = data.find(r => r.id == id);

        if (!resa) return res.status(404).send("Réservation introuvable");

        const BASE_URL = process.env.BASE_URL || "https://reservation-cinepop.onrender.com";
        const qrData = `${BASE_URL}/verify?id=${resa.id}`;
        const qrCodeBase64 = await QRCode.toDataURL(qrData);

        const html = `
        <div style="width:280px; font-family:Arial; border:2px dashed black; padding:20px; text-align:center;">
            <h2>TICKET CINEPOP</h2>
            <hr>
            <h1>${resa.filmTitle}</h1>
            <p><b>Salle :</b> ${resa.roomNumber}</p>
            <p><b>Date :</b> ${resa.sessionDate}</p>
            <p><b>Heure :</b> ${resa.sessionTime}</p>
            <p><b>Client :</b> ${resa.clientName}</p>
            <p><b>Places :</b> ${resa.peopleNumber}</p>
            <img src="${qrCodeBase64}" style="width:120px;" />
            <p style="font-size:10px;">Ticket #${resa.id}</p>
        </div>`;

        const browser = await puppeteer.launch({
            args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        await page.setContent(html);
        const buffer = await page.pdf({ format: "A6", printBackground: true });
        await browser.close();

        const transporter = await createTransporter();
        await transporter.sendMail({
            from: `"CinéPop" <${process.env.EMAIL_USER}>`,
            to: resa.email,
            subject: "🎟️ Votre billet CinéPop",
            text: `Bonjour ${resa.clientName}, votre réservation pour "${resa.filmTitle}" est confirmée !`,
            attachments: [{ filename: `ticket-${resa.id}.pdf`, content: buffer }]
        });

        resa.status = "validé";
        resa.validatedAt = new Date();
        fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

        res.send("Ticket envoyé !");
    } catch (err) {
        console.error(err);
        res.status(500).send("Erreur lors de la validation");
    }
});

// ❌ Refuser réservation
app.post("/api/refuser", async (req, res) => {
    try {
        const { id } = req.body;
        let data = JSON.parse(fs.readFileSync(FILE));
        const resa = data.find(r => r.id == id);

        if (!resa) return res.status(404).send("Réservation introuvable");

        const transporter = await createTransporter();
        await transporter.sendMail({
            from: `"CinéPop" <${process.env.EMAIL_USER}>`,
            to: resa.email,
            subject: "❌ Réservation refusée",
            text: `Bonjour ${resa.clientName}, votre réservation pour "${resa.filmTitle}" a été refusée.`
        });

        resa.status = "refusé";
        resa.refusedAt = new Date();
        fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

        res.send("Réservation refusée");
    } catch (err) {
        console.error(err);
        res.status(500).send("Erreur lors du refus");
    }
});

// 🔎 Vérification QR code
app.get("/verify", (req, res) => {
    const id = req.query.id;
    const data = JSON.parse(fs.readFileSync(FILE));
    const resa = data.find(r => r.id == id);

    if (!resa) return res.send("<h1>❌ Ticket invalide</h1>");
    if (resa.status !== "validé") return res.send("<h1>⏳ Ticket non validé</h1>");

    const now = DateTime.now().setZone("Europe/Paris").toJSDate();
    const sessionDateTime = DateTime.fromFormat(`${resa.sessionDate} ${resa.sessionTime}`, "yyyy-MM-dd HH:mm", { zone: "Europe/Paris" }).toJSDate();

    const startWindow = new Date(sessionDateTime);
    startWindow.setMinutes(startWindow.getMinutes() - 30);
    const endWindow = new Date(sessionDateTime);
    endWindow.setMinutes(endWindow.getMinutes() + 5);

    if (now < startWindow || now > endWindow) return res.send("<h1>⛔ Ticket hors créneau</h1>");

    res.send(`<h1>✅ Ticket VALIDE</h1><p>Client : ${resa.clientName}</p><p>Film : ${resa.filmTitle}</p>`);
});

// Nettoyage automatique toutes les heures
setInterval(cleanOldReservations, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Serveur lancé sur le port " + PORT);
});