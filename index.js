// @ts-check

require('dotenv').config();
const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

const { socketManager } = require("./controllers/socketController")
const { CronJob } = require("./cronjob");

const reqRoutes = require("./routes/controllerRoutes");
const mikrotikRoutes = require("./routes/mikrotikRoutes");
const mpesaRoutes = require("./routes/mpesaController");
const mailRoutes = require("./routes/mailRoutes");
const twofaRoutes = require("./routes/twoFARoutes");
const smsRoutes = require("./routes/smsRoutes");
const supportRoutes = require("./routes/supportRoutes");

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);

// Middlewares
app.use(cors({ origin: "*" }));
app.use(compression());
app.use(express.json({ limit: "200kb" }));
app.use(express.urlencoded({ extended: true, limit: "200kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Routes
app.use("/req", reqRoutes);
app.use("/mkt", mikrotikRoutes);
app.use("/mpesa", mpesaRoutes);
app.use("/mail", mailRoutes);
app.use("/twofa", twofaRoutes);
app.use("/sms", smsRoutes);
app.use("/support", supportRoutes);

socketManager.SocketInstance(server);

// Serve the homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Handle 404 errors
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
});

const PORT = process.env.PORT || 3013;

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  try {
    const cron = new CronJob();
    cron.start();
    console.log("Cron jobs started.");
  } catch (error) {
    console.error("Failed to start cron jobs:", error);
  }
});
