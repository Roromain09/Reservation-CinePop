process.env.NODE_OPTIONS = '--dns-result-order=ipv4first';
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const { DateTime } = require("luxon");
const express = require("express");
const fs = require("fs");
const bodyParser = require("body-parser");
const QRCode = require("qrcode");
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

// --- ENVOI EMAIL VIA API GMAIL ---
const MailComposer = require("nodemailer/lib/mail-composer");

async function sendEmailAPI({ to, subject, html, attachments = [] }) {
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const mail = new MailComposer({
        from: `"CinéPop" <${process.env.EMAIL}>`,
        to,
        subject,
        html,
        attachments: attachments.map(att => ({
            filename: att.filename,
            content: att.content,
            encoding: "base64"
        }))
    });

    const message = await mail.compile().build();

    const encodedMessage = message
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

    await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw: encodedMessage }
    });
}

// --- FONCTION POUR SÉCURISER LE HTML ---
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
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

        // QR Code buffer
        const qrBuffer = await QRCode.toBuffer(qrData);
        const qrBase64 = qrBuffer.toString("base64");

        const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    body { font-family: Arial; }
    .ticket {
        width: 280px;
        border: 2px dashed black;
        padding: 20px;
        text-align: center;
        margin: 0 auto;
    }
</style>
</head>
<body>
    <div class="ticket">
        <h2>TICKET CINEPOP</h2>
        <hr>
        <h1>${escapeHtml(resa.filmTitle)}</h1>
        <p><b>Salle :</b> ${escapeHtml(resa.roomNumber)}</p>
        <p><b>Date :</b> ${escapeHtml(resa.sessionDate)}</p>
        <p><b>Heure :</b> ${escapeHtml(resa.sessionTime)}</p>
        <p><b>Client :</b> ${escapeHtml(resa.clientName)}</p>
        <p><b>Places :</b> ${escapeHtml(resa.peopleNumber)}</p>
        <img src="data:image/png;base64,${qrBase64}" style="width:120px;" />
        <p style="font-size:10px;">Ticket #${resa.id}</p>
    </div>
</body>
</html>
`;

        // --- LANCEMENT PUPPETEER ---
        const browser = await puppeteer.launch({
            args: [
                ...chromium.args,
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--single-process",
                "--no-zygote"
            ],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();

        await page.setContent(html, { waitUntil: "networkidle0" });

        const buffer = await page.pdf({
            width: "300px",
            height: "500px",
            printBackground: true
        });

        await browser.close();

        // TESTS
        console.log("Taille PDF généré :", buffer.length);
        fs.writeFileSync("test.pdf", buffer);

        if (buffer.length < 5000) {
            console.error("❌ PDF trop petit → Chromium n'a rien rendu");
        }

        await sendEmailAPI({
            to: resa.email,
            subject: "🎟️ Votre billet CinéPop",
            html: `Bonjour ${escapeHtml(resa.clientName)}, votre réservation pour <b>${escapeHtml(resa.filmTitle)}</b> est confirmée !`,
            attachments: [
                { filename: `ticket-${resa.id}.pdf`, content: buffer }
            ]
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

        await sendEmailAPI({
            to: resa.email,
            subject: "❌ Réservation refusée",
            html: `Bonjour ${escapeHtml(resa.clientName)}, votre réservation pour <b>${escapeHtml(resa.filmTitle)}</b> a été refusée.`
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

    if (!resa) {
        return res.send(`
        <html><body style="font-family:Arial;text-align:center;padding-top:80px;">
            <img src="/img/cross.png" style="width:120px;">
            <h1 style="color:#c00;">Ticket invalide</h1>
        </body></html>
        `);
    }

    if (resa.status !== "validé") {
        return res.send(`
<html>
<head>
<meta charset="UTF-8">
<style>
    body { font-family:Arial;text-align:center;padding-top:80px; }
    h1 { color:#c00; }
</style>
</head>
<body>
    <audio autoplay>
        <source src="/sounds/error.mp3" type="audio/mpeg">
    </audio>

    <img src="/img/cross.png" style="width:120px;">
    <h1>Ticket invalide</h1>
</body>
</html>
`);
    }

    const now = DateTime.now().setZone("Europe/Paris").toJSDate();
    const sessionDateTime = DateTime.fromFormat(
        `${resa.sessionDate} ${resa.sessionTime}`,
        "yyyy-MM-dd HH:mm",
        { zone: "Europe/Paris" }
    ).toJSDate();

    const startWindow = new Date(sessionDateTime);
    startWindow.setMinutes(startWindow.getMinutes() - 30);
    const endWindow = new Date(sessionDateTime);
    endWindow.setMinutes(endWindow.getMinutes() + 5);

    if (now < startWindow || now > endWindow) {
        return res.send(`
        <!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Ticket CinéPop</title>
<style>
    body {
        background: #fff;
        font-family: Arial, sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        text-align: center;
    }
    .card {
        padding: 40px;
        border-radius: 12px;
        width: 350px;
        border: 2px solid #e0e0e0;
        box-shadow: 0 10px 25px rgba(0,0,0,0.08);
    }
    h1 {
        color: #e74c3c;
        font-size: 32px;
        margin-bottom: 10px;
    }
    p {
        font-size: 18px;
        color: #333;
        margin: 6px 0;
    }
    .icon {
        width: 120px;
        margin-bottom: 20px;
    }
    .tap {
        margin-top: 20px;
        font-size: 16px;
        color: #888;
    }
</style>
</head>
<body>

    <div class="card">
        <img src="/img/cross.png" class="icon">
        <h1>{{TITRE}}</h1>
        <p class="tap">Touchez l’écran pour jouer le bip d’erreur</p>
    </div>

<script>
document.body.addEventListener("click", async () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const response = await fetch("/sounds/error.mp3");
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.start(0);
});
</script>

</body>
</html>
        `);
    }

    // --- PAGE TICKET VALIDE ---
    let page = `
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Ticket CinéPop</title>
<style>
    body {
        background: #fff;
        font-family: Arial, sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        text-align: center;
    }
    .card {
        padding: 40px;
        border-radius: 12px;
        width: 350px;
        border: 2px solid #e0e0e0;
        box-shadow: 0 10px 25px rgba(0,0,0,0.08);
    }
    h1 {
        color: #2ecc71;
        font-size: 32px;
        margin-bottom: 10px;
    }
    p {
        font-size: 18px;
        color: #333;
        margin: 6px 0;
    }
    .icon {
        width: 120px;
        margin-bottom: 20px;
    }
    .tap {
        margin-top: 20px;
        font-size: 16px;
        color: #888;
    }
</style>
</head>
<body>

    <div class="card" id="card">
        <img src="/img/check.png" class="icon">
        <h1>Ticket VALIDE</h1>
        <p><b>Client :</b> {{CLIENT}}</p>
        <p><b>Film :</b> {{FILM}}</p>
        <p><b>Salle :</b> {{SALLE}}</p>
        <p><b>Date :</b> {{DATE}}</p>
        <p><b>Heure :</b> {{HEURE}}</p>

        <p class="tap">Touchez l’écran pour jouer le bip</p>
    </div>

<script>
document.body.addEventListener("click", async () => {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const response = await fetch("/sounds/valid.mp3");
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.start(0);
});
</script>

</body>
</html>
`;

    res.send(page);
});

// Nettoyage automatique toutes les heures
setInterval(cleanOldReservations, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Serveur lancé sur le port " + PORT);
});