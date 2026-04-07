process.env.NODE_OPTIONS = '--dns-result-order=ipv4first';
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
const { DateTime } = require("luxon");
const express = require("express");
const fs = require("fs");
const bodyParser = require("body-parser");
const QRCode = require("qrcode");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const { randomUUID } = require("crypto");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

const FILE = "reservations.json";

// Créer le fichier si inexistant
if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, "[]");
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
        id: randomUUID(),
        status: "en attente",
        createdAt: new Date(),
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

// 📩 Valider + Générer PDF pour téléchargement
app.post("/api/valider", async (req, res) => {
    try {
        const { id } = req.body;
        let data = JSON.parse(fs.readFileSync(FILE));
        const resa = data.find(r => r.id === id);

        if (!resa) return res.status(404).send("Réservation introuvable");

        const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
        const qrData = `${BASE_URL}/verify?id=${resa.id}`;

        const qrBuffer = await QRCode.toBuffer(qrData);
        const qrBase64 = qrBuffer.toString("base64");

        const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 0; }
    .ticket {
        width: 260px;
        border: 2px dashed #333;
        padding: 20px;
        text-align: center;
        margin: 10px auto;
        background: #fff;
    }
    h2 { margin: 0; color: #e74c3c; }
    hr { border: 0; border-top: 1px solid #eee; margin: 15px 0; }
    .film { font-size: 20px; font-weight: bold; margin: 10px 0; }
    .details { font-size: 14px; text-align: left; }
    .qr { margin-top: 15px; }
</style>
</head>
<body>
    <div class="ticket">
        <h2>CINEPOP</h2>
        <p style="font-size: 10px;">BILLET DE CINÉMA</p>
        <hr>
        <div class="film">${escapeHtml(resa.filmTitle)}</div>
        <div class="details">
            <p><b>Salle :</b> ${escapeHtml(resa.roomNumber)}</p>
            <p><b>Date :</b> ${escapeHtml(resa.sessionDate)}</p>
            <p><b>Heure :</b> ${escapeHtml(resa.sessionTime)}</p>
            <p><b>Places :</b> ${escapeHtml(resa.peopleNumber)}</p>
            <p><b>Client :</b> ${escapeHtml(resa.clientName)}</p>
        </div>
        <div class="qr">
            <img src="data:image/png;base64,${qrBase64}" style="width:130px;" />
        </div>
        <p style="font-size:9px; color: #888; margin-top:10px;">ID: ${resa.id}</p>
    </div>
</body>
</html>`;

        const browser = await puppeteer.launch({
            args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: "networkidle0" });

        const buffer = await page.pdf({
            width: "320px",
            height: "550px",
            printBackground: true,
            margin: { top: 0, right: 0, bottom: 0, left: 0 }
        });

        await browser.close();

        // Mettre à jour le statut dans le JSON
        resa.status = "validé";
        resa.validatedAt = new Date();
        fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

        // Envoyer le fichier PDF
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=ticket-${resa.id}.pdf`);
        res.send(buffer);

    } catch (err) {
        console.error("Erreur génération PDF:", err);
        res.status(500).send("Erreur lors de la validation");
    }
});

// ❌ Refuser réservation (pas de mail envoyé, juste changement de statut)
app.post("/api/refuser", (req, res) => {
    const { id } = req.body;
    let data = JSON.parse(fs.readFileSync(FILE));
    const resa = data.find(r => r.id === id);

    if (!resa) return res.status(404).send("Réservation introuvable");

    resa.status = "refusé";
    resa.refusedAt = new Date();
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    res.send("Réservation refusée");
});

// 🔎 Vérification QR code (Reste inchangé)
app.get("/verify", (req, res) => {
    const id = req.query.id;
    const check = req.query.check;

    const data = JSON.parse(fs.readFileSync(FILE));
    const resa = data.find(r => r.id === id);

    if (check == "1") {
        if (!resa) return res.json({ status: "invalid", reason: "Identifiant inexistant" });
        if (resa.status == "refusé") return res.json({ status: "invalid", reason: "réservation refusée" });
        if (resa.status == "en attente") return res.json({ status: "invalid", reason: "réservation en attente" });

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
            return res.json({ status: "invalid", reason: "Hors délai" });
        }

        return res.json({
            status: "valid",
            client: resa.clientName,
            film: resa.filmTitle,
            salle: resa.roomNumber,
            date: resa.sessionDate,
            heure: resa.sessionTime
        });
    }

    // Le HTML de la page de vérification (celui avec le bouton bleu) reste identique à votre version initiale...
    res.send(`...votre code HTML de vérification ici...`); 
});

setInterval(cleanOldReservations, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Serveur lancé sur http://localhost:" + PORT);
});