require('dns').setDefaultResultOrder('ipv4first');
require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const XLSX = require("xlsx");
const loginCodes = {};
const cors = require("cors");
const helmet = require("helmet");
const multer = require("multer");
const ArabicReshaper = require("arabic-reshaper");
const SCANNER_JWT_SECRET = process.env.SCANNER_JWT_SECRET || "scannersecret123";
const SCANNER_USERS_PATH = path.join(__dirname, "scanner-users.json");


const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const ADMINS = {
  main: {
    username: "main_admin",
    password: bcrypt.hashSync(process.env.ADMIN_MAIN_PASSWORD, 10)
  },
  pch: {
    username: "PCH_admin",
    password: bcrypt.hashSync(process.env.ADMIN_PCH_PASSWORD, 10)
  },
  pcc: {
    username: "PCC_admin",
    password: bcrypt.hashSync(process.env.ADMIN_PCC_PASSWORD, 10)
  },
  gc: {
    username: "GC_admin",
    password: bcrypt.hashSync(process.env.ADMIN_GC_PASSWORD, 10)
  },
  pp: {
    username: "PP_admin",
    password: bcrypt.hashSync(process.env.ADMIN_PP_PASSWORD, 10)
  }
};

const app = express();
const PORT = 3000;

const BASE_URL = process.env.PUBLIC_BASE_URL || "http://192.168.1.5:3000";
console.log("BASE URL:", BASE_URL);
const JWT_SECRET = process.env.JWT_SECRET || "oiouay97a629evui";

const UPLOAD_DIR = path.join(__dirname,"uploads");

function resolveExcelFile(preferred, fallbacks = []) {
  const candidates = [preferred, ...fallbacks];
  for (const name of candidates) {
    const full = path.join(__dirname, name);
    if (fs.existsSync(full)) return full;
  }
  throw new Error(`Excel file not found. Tried: ${candidates.join(", ")}`);
}

const ticketsExcelPath = resolveExcelFile("KermesseEleve2026.xlsx", ["kermesseEleves2026.xlsx"]);
const activeEmailsPath = resolveExcelFile("ActiveEmail2026.xlsx", ["ActiveEmails.xlsx"]);

const ticketsWorkbook = XLSX.readFile(ticketsExcelPath);
const ticketsSheet = ticketsWorkbook.Sheets[ticketsWorkbook.SheetNames[0]];
const ticketsData = XLSX.utils.sheet_to_json(ticketsSheet);
const activeWorkbook = XLSX.readFile(activeEmailsPath);
const activeSheet = activeWorkbook.Sheets[activeWorkbook.SheetNames[0]];
const activeEmailsData = XLSX.utils.sheet_to_json(activeSheet, { header: 1 });

const activeEmails = activeEmailsData
  .flat()
  .map(e => String(e).toLowerCase().trim())
  .filter(e => e.includes("@"));

app.use(cors());
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json());
app.use(express.urlencoded({extended:true}));
app.use(express.static(path.join(__dirname,"public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/verify-code", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "/code.html"));
});

if(!fs.existsSync(UPLOAD_DIR)){
fs.mkdirSync(UPLOAD_DIR);
}

ensureScannerUsersFile();

function ensureScannerUsersFile() {
  if (fs.existsSync(SCANNER_USERS_PATH)) return;
  const defaultUsers = [
    { username: "scanner1", password: "ChangeMe1!" },
    { username: "scanner2", password: "ChangeMe2!" },
    { username: "scanner3", password: "ChangeMe3!" },
    { username: "scanner4", password: "ChangeMe4!" },
    { username: "scanner5", password: "ChangeMe5!" },
    { username: "scanner6", password: "ChangeMe6!" },
    { username: "scanner7", password: "ChangeMe7!" },
    { username: "scanner8", password: "ChangeMe8!" }
  ];
  fs.writeFileSync(SCANNER_USERS_PATH, JSON.stringify(defaultUsers, null, 2));
  console.warn("Created scanner-users.json with default passwords — change them before production.");
}

function loadScannerUsers() {
  ensureScannerUsersFile();
  try {
    return JSON.parse(fs.readFileSync(SCANNER_USERS_PATH, "utf8"));
  } catch {
    return [];
  }
}

function scannerPasswordOk(stored, attempt) {
  if (!stored || !attempt) return false;
  const s = String(stored);
  if (s.startsWith("$2")) {
    try {
      return bcrypt.compareSync(attempt, s);
    } catch {
      return false;
    }
  }
  const a = Buffer.from(String(attempt));
  const b = Buffer.from(s);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyAdminToken(req, res, next) {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ ok: false, message: "No token provided" });
  if (token === "admin123") {
    req.admin = { adminType: "pp" }; 
    next();
  } else {
    res.status(403).json({ ok: false, message: "Invalid token" });
  }
}

app.use("/uploads",express.static(UPLOAD_DIR));
const storage = multer.diskStorage({
destination:(req,file,cb)=>cb(null,UPLOAD_DIR),
filename:(req,file,cb)=>{
const ext = path.extname(file.originalname);
cb(null,Date.now()+"-"+crypto.randomUUID()+ext);
}
});

const upload = multer({
storage,
limits:{fileSize:10*1024*1024}
});
const transporter = nodemailer.createTransport({
service: "gmail",
auth: {
user: process.env.SMTP_USER,
pass: process.env.SMTP_PASS
}
});

const DB_PATH = path.join(__dirname,"bookings.json");
const STATS_PATH = path.join(__dirname, "adminStats.json");
const ADMIN_PAGE_JSON = {
  pch: path.join(__dirname, "admin-pch.json"),
  pcc: path.join(__dirname, "admin-pcc.json"),
  gc: path.join(__dirname, "admin-gc.json"),
  pp: path.join(__dirname, "admin-pp.json")
};

function loadStats(){
  if(!fs.existsSync(STATS_PATH)){
    fs.writeFileSync(STATS_PATH, JSON.stringify({
      pch: 0,
      pcc: 0,
      gc: 0
    }, null, 2));
  }
  return JSON.parse(fs.readFileSync(STATS_PATH, "utf8"));
}

function saveStats(data){
  fs.writeFileSync(STATS_PATH, JSON.stringify(data, null, 2));
}

function ensureAdminPageJsonFiles() {
  Object.values(ADMIN_PAGE_JSON).forEach((filePath) => {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "[]");
    }
  });
}

function loadAdminPageLog(adminType) {
  const filePath = ADMIN_PAGE_JSON[adminType];
  if (!filePath) return [];
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "[]");
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

function saveAdminPageLog(adminType, data) {
  const filePath = ADMIN_PAGE_JSON[adminType];
  if (!filePath) return;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function appendAdminPageLog(adminType, booking, actionBy) {
  const rows = loadAdminPageLog(adminType);
  rows.push({
    bookingId: booking.bookingId,
    firstName: booking.firstName,
    lastName: booking.lastName,
    email: booking.email,
    studentName: booking.studentName,
    nationalId: booking.nationalId,
    school: booking.school,
    status: booking.status,
    photo: booking.photo,
    sentAt: new Date().toISOString(),
    sentByAdmin: actionBy || adminType
  });
  saveAdminPageLog(adminType, rows);
}

ensureAdminPageJsonFiles();

function loadBookings(){

if(!fs.existsSync(DB_PATH)){
fs.writeFileSync(DB_PATH,"[]");
}

return JSON.parse(fs.readFileSync(DB_PATH,"utf8"));

}

function saveBookings(data){

fs.writeFileSync(DB_PATH,JSON.stringify(data,null,2));

}
 function loadScanned(){
  try{
    return JSON.parse(fs.readFileSync("scanned.json"));
  }catch{
    return [];
  }
}

function saveScanned(data){
  fs.writeFileSync("scanned.json", JSON.stringify(data,null,2));
}
 function verifyStudent(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token) {
    return res.status(401).json({ ok: false, error: "Missing token" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.role !== "student") {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    if (!decoded.email || !decoded.email.endsWith("@jesuitescsf.com")) {
      return res.status(403).json({ ok: false, error: "Invalid school account" });
    }

    req.student = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}
function verifyAdmin(req,res,next){

const auth=req.headers.authorization || "";

const token = auth.startsWith("Bearer ")
  ? auth.slice(7)
  : "";

if(!token){
return res.status(401).json({ok:false});
}

try{

const decoded = jwt.verify(token,JWT_SECRET);

if(decoded.role !== "admin"){
  return res.status(403).json({ok:false});
}

req.admin = decoded;

next();

}catch(err){

return res.status(401).json({ok:false});

}

}

function verifyToken(token){
return jwt.verify(token,JWT_SECRET);
}

function signToken(payload){
return jwt.sign(payload,JWT_SECRET,{expiresIn:"10m"});
}

app.get("/api/admin/all-payment-pending", verifyMainAdmin, (req,res)=>{
  try{

    const bookings = loadBookings();

    const pending = bookings
      .filter(b => b.status === "PAYMENT_PENDING")
      .sort((a, b) => {
        const nameA = a.lastName + " " + a.firstName;
        const nameB = b.lastName + " " + b.firstName;
        return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
      })
      .map(b => ({
        ...b,
        photo: `${BASE_URL}/uploads/${b.photo}`
      }));

    res.json({
      ok: true,
      data: pending
    });

  }catch(err){
    console.error(err);
    res.json({ok:false});
  }
});

app.post("/api/send-code", async (req,res)=>{

  try{

    const email = (req.body.email || "").toLowerCase().trim();

    if(!email.endsWith("@jesuitescsf.com")){
      return res.json({ok:false,error:"Use your school email"});
    }
if(!activeEmails.includes(email)){
  return res.json({
    ok:false,
    error:"This email is not authorized"
  });
}
    const code = Math.floor(100000 + Math.random()*900000).toString();

    loginCodes[email] = {
      code,
      expires: Date.now() + 5*60*1000
    };

    await transporter.sendMail({
      from:process.env.SMTP_USER,
      to:email,
      subject:"Code de vérification — Kermesse CSF 2026",
      html:`<div style="font-family:Arial;line-height:1.8">

              <!-- FRENCH -->
              <h2>Kermesse CSF 2026</h2>
              <p><b>Bonjour,</b></p>
              <p>Votre code de vérification est : <b>${code}</b></p>
              <p>Votre code est valable pendant 5 minutes.</p>

              <hr>

              <div dir="rtl">
                <h2>Kermesse CSF 2026</h2>
                <p><b>مرحباً ،</b></p>
                <p>رمز التحقق الخاص بك هو : <b>${code}</b></p>
                <p>رمز التحقق الخاص بك سينتهي بعد 5 دقائق.</p>
              </div>

            </div>`
    });

    res.json({ok:true});

  }catch(err){

    console.error(err);
    res.json({ok:false});

  }

});

function verifyPaymentPendingAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token) return res.status(401).json({ ok: false });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.role !== "admin" || decoded.adminType !== "paymentPending") {
      return res.status(403).json({ ok: false });
    }

    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ ok: false });
  }
}

app.post("/api/verify-code",(req,res)=>{

  const email = (req.body.email || "").toLowerCase().trim();
  const code = req.body.code;

  const record = loginCodes[email];

  if(!record){
    return res.json({ok:false,error:"Code not found"});
  }

  if(record.code !== code){
    return res.json({ok:false,error:"Wrong code"});
  }

  if(Date.now() > record.expires){
    return res.json({ok:false,error:"Code expired"});
  }

  delete loginCodes[email];

  const token = jwt.sign(
    {role:"student", email},
    JWT_SECRET,
    {expiresIn:"1h"}
  );

  res.json({ok:true,token});

});
app.post("/api/book", verifyStudent,
upload.fields([
{name:"photo",maxCount:1}
]),
async(req,res)=>{

try{

const firstName = (req.body.firstName || "").trim();
const lastName = (req.body.lastName || "").trim();
const nationalId = (req.body.nationalId || "").trim();
const email = req.student.email;
const studentName = getStudentNameFromEmail(email);
const studentId = getStudentId(email);
const photo = req.files?.photo?.[0];
const lang = req.body.lang || "fr";
const school = req.body.school   

if(!photo){
  return res.status(400).json({ ok:false, error:"Photo missing" });
}

const bookingId=crypto.randomUUID();

const bookings = loadBookings();

let bookingCount = bookings.filter(b => b.studentId === studentId).length;
let status = "PENDING";


const booking = {
  bookingId,
  firstName,
  lastName,
  email,
  studentName,
  studentId,
  school,
  nationalId,

   
  lang: req.body.lang || "fr",
  photo: photo.filename,
  status,
  date: new Date().toISOString()
};

bookings.push(booking);

saveBookings(bookings);


if(status==="PENDING"){

 const emailHTML = `
<div style="font-family:Arial;line-height:1.8">

  <!-- FRENCH -->
  <h2>Kermesse CSF 2026</h2>
  <p><b>Bonjour,</b></p>
  <p>Votre demande d'invitation pour ${lastName} a été reçue.</p>
  <p>Vous serez informé de son évolution.</p>

  <hr>

  <!-- ARABIC -->
  <div dir="rtl">
    <h2>Kermesse CSF 2026</h2>
    <p><b>مرحباً ،</b></p>
    <p>تم استلام طلب الدعوة الخاص بـ ${lastName} بنجاح.</p>
    <p>طلبك الآن <b>في انتظار الموافقة</b>.</p>
  </div>

</div>
`;

await transporter.sendMail({
  from: process.env.SMTP_USER,
  to: email,
  subject: "Demande reçue — Kermesse CSF 2026",
  html: emailHTML
});

console.log("Pending email sent");

}else{

const token = signToken({action:"ticket", bookingId});

const verifyUrl = `${BASE_URL}/verify.html?token=${token}`;

const qr = await QRCode.toBuffer(verifyUrl);

const doc = new PDFDocument();
const buffers = [];

doc.on("data", d => buffers.push(d));

doc.fontSize(22).text("Kermesse CSF 2026");
doc.moveDown();
doc.fontSize(16).text(firstName + " " + lastName);
doc.moveDown();
doc.image(qr,{width:200});
doc.end();

const pdf = await new Promise(resolve=>{
doc.on("end",()=>resolve(Buffer.concat(buffers)));
});

 transporter.sendMail({
from:process.env.SMTP_USER,
to:email,
subject:"Kermesse CSF 2026 — Votre Ticket",
attachments:[{filename:"ticket.pdf",content:pdf}]
});

console.log("Ticket email sent");

}

res.json({ok:true});

}catch(err){

console.error(err);

res.status(500).json({ok:false});

}

}); app.post("/api/admin/login", async (req,res)=>{
  try{



const { username, password } = req.body;

const adminEntry = Object.entries(ADMINS).find(([role, data]) => data.username === username);

if(!adminEntry){
  return res.json({ok:false});
}

const [role, data] = adminEntry;

const valid = await bcrypt.compare(password, data.password);

if(!valid){
  return res.json({ok:false});
}

const token = jwt.sign(
  { role:"admin", adminType: role },
  JWT_SECRET,
  { expiresIn:"8h" }
);

res.json({
  ok: true,
  token,
  adminType: role 
});
  }catch(err){
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ok:false});
  
  }

});

function verifyMainAdmin(req,res,next){
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if(!token){
    return res.status(401).json({ok:false});
  }

  try{
    const decoded = jwt.verify(token, JWT_SECRET);

    if(decoded.role !== "admin" || decoded.adminType !== "main"){
      return res.status(403).json({ok:false});
    }

    next();
  }catch{
    return res.status(401).json({ok:false});
  }
}

function verifyPaymentAdmin(req,res,next){
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if(!token){
    return res.status(401).json({ok:false});
  }

  try{
   const decoded = jwt.verify(token,JWT_SECRET);

if(decoded.role !== "admin"){
  return res.status(403).json({ok:false});
}


req.admin = decoded;

next();
  }catch{
    return res.status(401).json({ok:false});
  }
}

app.get("/api/admin/pending", verifyAdmin, (req,res)=>{

try{

const bookings = loadBookings();

const pending = bookings
  .filter(b => b.status === "PENDING")
  .sort((a, b) => {
    const nameA = a.lastName + " " + a.firstName;
    const nameB = b.lastName + " " + b.firstName;
    return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
  })
  .map(b => ({
    ...b,
    photo: `${BASE_URL}/uploads/${b.photo}`
  }));
res.json({
  ok: true,
  data: pending
});

}catch(err){
console.error(err);
res.json({ok:false});
}

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

  

function fixArabic(text) {
  if (!text) return "";
  return ArabicReshaper.convertArabic(text);
}
function normalizeCodeFromEmail(value) {
  const text = String(value || "").toLowerCase().trim();
  if (!text) return "";
  const local = text.includes("@") ? text.split("@")[0] : text;
  return local.replace("parents_", "").replace(/[^0-9]/g, "");
}

function readEmailField(row) {
  return row.email || row.Email || row.mail || row.Mail || row["e-mail"] || row["E-mail"] || "";
}

function readFreeField(row) {
  return row.free || row.Free || row["free tickets"] || row["Free Tickets"] || row.gratuit || row.Gratuit || 0;
}

function readNameField(row) {
  return row.Name || row.name || row.Nom || row.nom || "";
}

function getFreeTicketsFromExcel(email){
  const code = normalizeCodeFromEmail(email);
  const row = ticketsData.find(r => normalizeCodeFromEmail(readEmailField(r)) === code);
  if(!row) return 0;
  return Number(readFreeField(row) || 0);
}
app.post("/api/admin/approve", verifyMainAdmin, async (req,res)=>{

try{ 

const bookingId = req.body.bookingId;

const bookings = loadBookings();
const booking = bookings.find(b => b.bookingId === bookingId);

if(!booking){
  return res.json({ok:false});
}




const approvedCount = bookings.filter(b =>
  b.email === booking.email &&
  (b.status === "TICKET_SENT" || b.status === "PAYMENT_PENDING")
).length;

const email = booking.email;
const firstName = booking.firstName;
const lastName = booking.lastName;


console.log("approvedCount:", approvedCount);
const freeTickets = getFreeTicketsFromExcel(booking.email);

console.log("Free tickets allowed:", freeTickets);
console.log("Already used:", approvedCount);

if (approvedCount < freeTickets) {

  booking.status = "TICKET_SENT";
  saveBookings(bookings);

  const token = signToken({ action: "ticket", bookingId });
  const verifyUrl = `${BASE_URL}/verify.html?token=${token}`;
  const qr = await QRCode.toBuffer(verifyUrl);

 

const doc = new PDFDocument({ size: [1000, 440], margin: 0 });
const buffers = [];
doc.on("data", chunk => buffers.push(chunk));

const bgPath = path.join(__dirname, "ticket.jpg");
doc.image(bgPath, 0, 0, { width: 1000, height: 440 });

const qrSize = 140; 
const whiteCenterX = 745 + (235 - qrSize) / 2; 
const qrY = 45; 

doc.image(qr, whiteCenterX, qrY, { width: qrSize });

const guestNameFixed = fixArabic(lastName); 

doc.fillColor("#000000") 
   .font(path.join(__dirname, "fonts/Cairo-Regular.ttf")) 
   .fontSize(18) 
   .text(guestNameFixed, 745, 195, { 
       width: 235, 
       align: "center" 
   });

const pdf = await new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);
    doc.end();
});
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: email,
    subject: "Kermesse CSF 2026 — Votre ticket",
    html: `
<div style="font-family:Arial;line-height:1.8">
  <h2>Kermesse CSF 2026</h2>

  <p><b>Bonjour,</b><br>
  Votre demande pour ${lastName} a été approuvée.<br>
  <b>Votre ticket est en pièce jointe.</b></p>

  <hr>

  <div dir="rtl">
    <p><b>مرحباً،</b><br>
    تمت الموافقة على طلبك ل ${lastName}<br>
    <b>تذكرتك مرفقة في هذا البريد.</b></p>
  </div>
</div>
`,
    attachments: [
      {
        filename: "ticket.pdf",
        content: pdf,
        contentType: "application/pdf"
      }
    ]
  });

  console.log("FREE ticket sent to:", email);

} else {

  booking.status = "PAYMENT_PENDING";
  saveBookings(bookings);

  const emailHTML = `
<div style="font-family:Arial;line-height:1.8">

  <h2>Kermesse CSF 2026</h2>
  <p><b>Bonjour,</b></p>
  <p>Votre demande pour ${lastName} a été acceptée.</p>
  <p>Votre billet est maintenant <b>en attente de paiement</b>.</p>
  <p>Veuillez effectuer le paiement pour recevoir votre ticket.</p>

  <hr>

  <div dir="rtl">
    <h2>Kermesse CSF 2026</h2>
    <p><b>مرحباً،</b></p>
    <p>تمت الموافقة على طلبك ل ${lastName}.</p>
    <p>تذكرتك الآن <b>في انتظار الدفع</b>.</p>
    <p>يرجى إتمام الدفع لاستلام التذكرة.</p>
  </div>

</div>
`;

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: email,
    subject: "Paiement requis — Kermesse CSF 2026",
    html: emailHTML
  });

  console.log("Payment pending email sent to:", email);
}
res.json({ok:true});

}catch(err){

console.error("APPROVE ERROR:", err);
res.status(500).json({ok:false, error:String(err)});

}

});
app.post("/api/admin/reject", verifyMainAdmin, async (req,res)=>{

try{

const bookingId = req.body.bookingId;

const bookings = loadBookings();

const booking = bookings.find(b => b.bookingId === bookingId);
const firstName = booking.firstName;
const lastName = booking.lastName;

if(!booking){
return res.json({ok:false});
}

booking.status = "REJECTED";

saveBookings(bookings);

 transporter.sendMail({
from:process.env.SMTP_USER,
to:booking.email,
subject:"Demande rejetée — Kermesse CSF 2026",
html:`
<div style="font-family:Arial;line-height:1.8">
  <h2>Kermesse CSF 2026</h2>
  <p><b>Bonjour,</b><br>
  Votre demande pour ${lastName} a été rejetée.</p>
  <hr>
  <div dir="rtl"><h2>Kermesse CSF 2026</h2><br><b>مرحباً،</b><br>
  تم رفض طلب الحجز الخاص ب ${lastName}.</div>
</div>
`});

res.json({ok:true});

}catch(err){

console.error(err);
res.json({ok:false});

}

});
app.post("/api/admin/delete", verifyMainAdmin, (req,res)=>{
  try{
    const bookingId = req.body.bookingId;
    const bookings = loadBookings();
    const next = bookings.filter(b => b.bookingId !== bookingId);
    if(next.length === bookings.length){
      return res.json({ok:false, error:"Booking not found"});
    }
    saveBookings(next);
    res.json({ok:true});
  }catch(err){
    console.error("DELETE ERROR:", err);
    res.status(500).json({ok:false});
  }
});
app.get("/api/admin/payment-pending", verifyAdmin, (req,res)=>{

try{

const bookings = loadBookings();

const adminType = req.admin.adminType;

const pending = bookings
.filter(b => {
  if (b.status !== "PAYMENT_PENDING") return false;
  if (adminType === "pp") return true;
  return (b.school || "").toLowerCase() === adminType;
})
.sort((a, b) => {
  const nameA = a.lastName + " " + a.firstName;
  const nameB = b.lastName + " " + b.firstName;
  return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
})
.map(b => ({
  ...b,
  photo: `${BASE_URL}/uploads/${b.photo}`
}));

res.json({
  ok: true,
  data: pending
});

}catch(err){
console.error(err);
res.json({ok:false});
}

});

app.get("/api/admin/export", verifyAdmin, async (req,res)=>{

try{

const bookings = loadBookings();

const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet("Bookings");

sheet.columns = [
{ header:"Booking ID", key:"bookingId", width:35 },
{ header:"First Name", key:"firstName", width:20 },
{ header:"Last Name", key:"lastName", width:20 },
{ header:"Email", key:"email", width:30 },
{ header:"Status", key:"status", width:15 },
{ header:"Date", key:"date", width:25 }
];

bookings.forEach(b=>{
sheet.addRow({
bookingId:b.bookingId,
firstName:b.firstName,
lastName:b.lastName,
email:b.email,
status:b.status,
date:new Date(b.date).toLocaleString()
});
});

res.setHeader(
"Content-Type",
"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
);

res.setHeader(
"Content-Disposition",
"attachment; filename=bookings.xlsx"
);

await workbook.xlsx.write(res);

res.end();

}catch(err){

console.error("EXPORT ERROR",err);
res.status(500).send("Export failed");

}

});

app.get("/api/admin/export-page/:adminType", verifyAdmin, async (req,res)=>{
  try{
    const adminType = String(req.params.adminType || "").toLowerCase();
    if(!ADMIN_PAGE_JSON[adminType]){
      return res.status(400).json({ok:false, error:"Unknown admin page"});
    }

    const rows = loadAdminPageLog(adminType);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`${adminType.toUpperCase()} Sent`);

    sheet.columns = [
      { header:"Booking ID", key:"bookingId", width:35 },
      { header:"First Name", key:"firstName", width:20 },
      { header:"Last Name", key:"lastName", width:20 },
      { header:"Email", key:"email", width:30 },
      { header:"Student Name", key:"studentName", width:25 },
      { header:"National ID", key:"nationalId", width:20 },
      { header:"School", key:"school", width:12 },
      { header:"Status", key:"status", width:15 },
      { header:"Sent At", key:"sentAt", width:25 },
      { header:"Sent By Admin", key:"sentByAdmin", width:18 }
    ];

    rows.forEach(r=>{
      sheet.addRow({
        ...r,
        sentAt: r.sentAt ? new Date(r.sentAt).toLocaleString() : ""
      });
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=${adminType}-sent-tickets.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();

  }catch(err){
    console.error("EXPORT PAGE ERROR", err);
    res.status(500).json({ok:false, error:"Export failed"});
  }
});

app.get("/api/verify", (req,res)=>{

try{

const token = req.query.token;

const decoded = verifyToken(token);

const bookings = loadBookings();

const booking = bookings.find(b => b.bookingId === decoded.bookingId);

if(!booking){
return res.json({valid:false});
} 

res.json({
  valid: true,
  name: booking.firstName + " " + booking.lastName,
  studentName: booking.studentName,
  nationalId: booking.nationalId, 
  email: booking.email,
  photo: `${BASE_URL}/uploads/${booking.photo}`,
  date: new Date(booking.date).toLocaleString()
});

}catch{

res.json({valid:false});

}

});

app.get("/api/me", verifyStudent, (req, res) => {
  res.json({
    ok: true,
    email: req.student.email,
    firstName: req.student.firstName || "",
    lastName: req.student.lastName || ""
  });
});

app.get("/payment-pending", verifyAdminToken, (req, res) => {
  const BOOKINGS_FILE = "./bookings.json";
  const bookings = JSON.parse(fs.readFileSync(BOOKINGS_FILE, "utf8") || "[]");

  const pending = bookings.filter(b => b.status === "PAYMENT_PENDING");

  res.json({ ok: true, data: pending });
});


app.post("/api/admin/send-ticket", verifyAdmin, async (req,res)=>{

try{

const bookingId = req.body.bookingId;

const bookings = loadBookings();
const booking = bookings.find(b => b.bookingId === bookingId);

if(!booking){
  return res.json({ok:false, error:"Booking not found"});
}

const email = booking.email;
const firstName = booking.firstName;
const lastName = booking.lastName;


booking.status = "TICKET_SENT";
saveBookings(bookings);

const stats = loadStats();

const adminType = req.admin.adminType;

stats[adminType] = (stats[adminType] || 0) + 1;

saveStats(stats);
appendAdminPageLog(adminType, booking, adminType);

const token = signToken({action:"ticket", bookingId});
const verifyUrl = `${BASE_URL}/verify.html?token=${token}`;


const qr = await QRCode.toBuffer(verifyUrl);




const doc = new PDFDocument({ size: [1000, 440], margin: 0 });
const buffers = [];
doc.on("data", chunk => buffers.push(chunk));

const bgPath = path.join(__dirname, "ticket.jpg");
doc.image(bgPath, 0, 0, { width: 1000, height: 440 });

const qrSize = 140; 
const whiteCenterX = 745 + (235 - qrSize) / 2; 
const qrY = 45; 

doc.image(qr, whiteCenterX, qrY, { width: qrSize });

const guestNameFixed = fixArabic(lastName); 

doc.fillColor("#000000") 
   .font(path.join(__dirname, "fonts/Cairo-Regular.ttf")) 
   .fontSize(18) 
   .text(guestNameFixed, 745, 195, { 
       width: 235, 
       align: "center" 
   });

const pdf = await new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);
    doc.end();
});
  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: email,
    subject: "Kermesse CSF 2026 — Votre Ticket",
    html: `
      <div style="font-family:Arial;line-height:1.8">
        <h2>Kermesse CSF 2026</h2>

        <p><b>Bonjour,</b><br>
        Votre demande pour ${lastName} a été approuvée.<br>
        <b>Votre ticket est en pièce jointe.</b></p>

        <hr>

        <div dir="rtl">
          <p><b>مرحباً،</b><br>
          تمت الموافقة على طلبك ل ${lastName}<br>
          <b>تذكرتك مرفقة في هذا البريد.</b></p>
        </div>
      </div>
`,
    attachments: [
      {
        filename: "ticket.pdf",
        content: pdf,
        contentType: "application/pdf"
      }
    ]
  });
  

res.json({ok:true});

}catch(err){

console.error("SEND TICKET ERROR:", err);
res.status(500).json({ok:false, error:String(err)});

}

});
function getStudentId(email){

email = email.toLowerCase();

if(email.startsWith("parents_")){
  return email.split("@")[0].replace("parents_","");
}

return email.split("@")[0];

}
 
function getStudentCodeFromEmail(email){
  return email.toLowerCase().split("@")[0].replace("parents_", "");
}
function getStudentNameFromEmail(email){
  const code = normalizeCodeFromEmail(email);
  const row = ticketsData.find(r => normalizeCodeFromEmail(readEmailField(r)) === code);

  if(!row){
    return email;
  }

  return String(readNameField(row) || "").trim() || email;
}
app.get("/api/admin/stats", verifyAdmin, (req,res)=>{
  try{

    const auth = req.headers.authorization || "";
    const token = auth.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const stats = loadStats();

const adminType = req.admin.adminType;
const tickets = stats[adminType] || 0;
    const totalMoney = tickets * 350;

    res.json({
      ok: true,
      tickets,
      totalMoney
    });

  }catch(err){
    console.error(err);
    res.json({ok:false});
  }
});
app.post("/api/scanner/login", (req,res)=>{
  try{
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const users = loadScannerUsers();
    const row = users.find(u => String(u.username || "").trim().toLowerCase() === username);

    if(!row || !scannerPasswordOk(row.password, password)){
      return res.status(401).json({ok:false, error:"Wrong username or password"});
    }

    const scannerToken = jwt.sign(
      { role: "scanner", username: row.username },
      SCANNER_JWT_SECRET,
      { expiresIn: "4h" }
    );

    res.json({ ok:true, token: scannerToken, username: row.username });

  }catch(err){
    console.error("SCANNER LOGIN ERROR:", err);
    res.status(500).json({ok:false});
  }
});

function verifyScanner(req,res,next){
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if(!token){
    return res.status(401).json({ok:false, error:"Missing scanner token"});
  }

  try{
    const decoded = jwt.verify(token, SCANNER_JWT_SECRET);

    if(decoded.role !== "scanner"){
      return res.status(403).json({ok:false, error:"Forbidden"});
    }

    req.scanner = decoded;
    next();

  }catch(err){
    return res.status(401).json({ok:false, error:"Invalid or expired scanner session"});
  }
}
app.post("/api/scanner/scan", verifyScanner, (req,res)=>{
  try{

    const { token } = req.body;

    if(!token){
      return res.json({ok:false, error:"No token"});
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.action !== "ticket" || !decoded.bookingId) {
      return res.json({ ok: false, error: "Invalid ticket token" });
    }

    const bookings = loadBookings();
    const scanned = loadScanned();

    const booking = bookings.find(b => b.bookingId === decoded.bookingId);

    if(!booking){
      return res.json({ok:false, error:"Booking not found"});
    }

    const scannerUser = req.scanner.username || "unknown";

    if(booking.scanned === true){
      return res.json({
        ok: true,
        alreadyScanned: true,
        reentry: true,
        guestName: `${booking.firstName || ""} ${booking.lastName || ""}`.trim(),
        nationalId: booking.nationalId,
        bookingId: booking.bookingId,
        photoUrl: `${BASE_URL}/uploads/${booking.photo}`,
        scannedBy: booking.scannedBy || "",
        scannedAt: booking.scannedAt || ""
      });
    }

 
    if(booking.status !== "TICKET_SENT"){
      return res.json({ok:false, error:"Not valid ticket"});
    }


    booking.scanned = true;
    booking.scannedAt = new Date().toISOString();
    booking.scannedBy = scannerUser;

    saveBookings(bookings);

     const exists = scanned.find(s => s.bookingId === booking.bookingId);

if(!exists){
  scanned.push({
    bookingId: booking.bookingId,
    firstName: booking.firstName,
    lastName: booking.lastName,
    email: booking.email,
    studentName: booking.studentName,
    nationalId: booking.nationalId,
    school: booking.school,
    scannedAt: booking.scannedAt,
    scannedBy: scannerUser
  });

  saveScanned(scanned);
}

    saveScanned(scanned);

    res.json({
      ok:true,
      alreadyScanned: false,
      reentry: false,
      guestName: `${booking.firstName || ""} ${booking.lastName || ""}`.trim(),
      nationalId: booking.nationalId,
      bookingId: booking.bookingId,
      photoUrl: `${BASE_URL}/uploads/${booking.photo}`,
      scannedBy: scannerUser,
      scannedAt: booking.scannedAt
    });

  }catch(err){
    console.error("SCAN ERROR:", err);
    res.json({ok:false, error:"Invalid token"});
  }
});
app.get("/api/scanner/stats", verifyScanner, (req,res)=>{
  try{
    const scanned = loadScanned();

    res.json({
      ok:true,
      scannedCount: scanned.length
    });

  }catch(err){
    console.error("SCANNER STATS ERROR:", err);
    res.status(500).json({ok:false});
  }
});

app.get("/api/scanner/export", verifyScanner, async (req,res)=>{
  try{

    const scanned = loadScanned();

    const workbook = new ExcelJS.Workbook();
const sheet = workbook.addWorksheet("Scanned Tickets");


sheet.columns = [
  { header:"Booking ID", key:"bookingId", width:35 },
  { header:"First Name", key:"firstName", width:20 },
  { header:"Last Name", key:"lastName", width:20 },
  { header:"Email", key:"email", width:30 },
  { header:"Student Name", key:"studentName", width:25 },
  { header:"National ID", key:"nationalId", width:20 },
  { header:"School", key:"school", width:15 },
  { header:"Scanned By", key:"scannedBy", width:18 },
  { header:"Scanned At", key:"scannedAt", width:25 }
];


sheet.spliceRows(1, 0, ["TOTAL SCANNED:", scanned.length]);
sheet.spliceRows(2, 0, []); 


scanned.forEach(s=>{
  sheet.addRow({
    bookingId: s.bookingId,
    firstName: s.firstName,
    lastName: s.lastName,
    email: s.email,
    studentName: s.studentName,
    nationalId: s.nationalId,
    school: s.school,
    scannedBy: s.scannedBy || "",
    scannedAt: new Date(s.scannedAt).toLocaleString()
  });
});

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      "attachment; filename=scanned-tickets.xlsx"
    );

    await workbook.xlsx.write(res);
    res.end();

  }catch(err){
    console.error("SCANNED EXPORT ERROR:", err);
    res.status(500).send("Export failed");
  }
});

app.use((req,res,next)=>{
  if(req.url.includes(".env") || req.url.includes("bookings.json")){
    return res.status(403).send("Forbidden");
  }
  next();
});
