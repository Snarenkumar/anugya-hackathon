require('dotenv').config();
const express = require('express');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');

const app = express();

// ======================
// 1. GEMINI AI INIT (CORRECT CONFIG)
// ======================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Use the correct model name for current API version
const model = genAI.getGenerativeModel({ 
  model: "gemini-1.5-flash", // Updated model name
  apiVersion: "v1" // Specify API version
});

// ======================
// 2. APP CONFIGURATION
// ======================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ======================
// 3. FILE UPLOAD SETUP
// ======================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
  }),
  fileFilter: (req, file, cb) => {
    const validTypes = ['image/jpeg', 'image/png'];
    cb(null, validTypes.includes(file.mimetype));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ======================
// 4. IMAGE PROCESSING
// ======================
async function preprocessImage(imagePath) {
  const processedPath = path.join(uploadDir, 'processed_' + path.basename(imagePath));
  await sharp(imagePath)
    .greyscale()
    .normalize()
    .linear(1.1)
    .sharpen()
    .toFile(processedPath);
  return processedPath;
}

// ======================
// 5. TEXT EXTRACTION
// ======================
async function extractText(imagePath) {
  const { data: { text } } = await Tesseract.recognize(
    imagePath,
    'eng',
    { logger: m => console.log(m.status) }
  );
  return text;
}

// ======================
// 6. GEMINI ANALYSIS (FIXED API CALL)
// ======================
async function analyzeIngredients(ingredients) {
  try {
    const prompt = `Analyze these food ingredients and provide:
    - Product name
    - Health risks (⚠️ warnings)
    - Recommended consumption
    - Risk rating (Low/Moderate/High)
    - Healthier alternatives
    
    Ingredients: ${ingredients.substring(0, 5000)}
    
    Respond in JSON format exactly like this example:
    {
      "productName": "Detected Product Name",
      "ingredients": ["list", "of", "ingredients"],
      "healthWarnings": [
        {"ingredient": "Sugar", "risk": "High sugar content", "level": "High"}
      ],
      "recommendations": {
        "safeConsumption": "Limit to 1 serving per day",
        "riskRating": "Moderate",
        "alternatives": ["Healthier option 1", "Option 2"]
      }
    }`;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    // Clean and parse response
    const cleanText = text.replace(/```json|```/g, '');
    return JSON.parse(cleanText);
    
  } catch (err) {
    console.error('Gemini Error:', err);
    throw new Error('AI analysis failed. Please try again with clearer text.');
  }
}

// ======================
// 7. ROUTES
// ======================
app.get('/', (req, res) => res.render('index'));

app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) throw new Error('Please upload an image');
    
    // Process image
    const processedPath = await preprocessImage(req.file.path);
    const text = await extractText(processedPath);
    
    // Analyze with Gemini
    const analysis = await analyzeIngredients(text);
    
    // Cleanup
    fs.unlinkSync(processedPath);
    
    // Render results
    res.render('result', {
      imagePath: `/uploads/${path.basename(req.file.filename)}`,
      analysis: analysis
    });
    
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { 
      message: err.message 
    });
  }
});

// ======================
// 8. START SERVER
// ======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));