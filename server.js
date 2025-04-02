require('dotenv').config();
const express = require('express');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser');

const app = express();

// ======================
// 1. GEMINI AI INIT
// ======================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-1.5-flash",
  apiVersion: "v1"
});

// ======================
// 2. APP CONFIGURATION
// ======================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ======================
// 3. FILE UPLOAD SETUP (FOR BOTH REGULAR UPLOADS AND CAMERA CAPTURES)
// ======================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    cb(null, validTypes.includes(file.mimetype));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// ======================
// 4. IMAGE PROCESSING FUNCTIONS
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

async function extractText(imagePath) {
  const { data: { text } } = await Tesseract.recognize(
    imagePath,
    'eng',
    { logger: m => console.log(m.status) }
  );
  return text;
}

// ======================
// 5. GEMINI ANALYSIS
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
    
    const cleanText = text.replace(/```json|```/g, '');
    return JSON.parse(cleanText);
    
  } catch (err) {
    console.error('Gemini Error:', err);
    throw new Error('AI analysis failed. Please try again with clearer text.');
  }
}

// ======================
// 6. HELPER FUNCTION TO SAVE BASE64 IMAGES
// ======================
function saveBase64Image(base64Data) {
  const matches = base64Data.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    throw new Error('Invalid base64 image data');
  }

  const extension = matches[1] === 'jpeg' ? 'jpg' : matches[1];
  const filename = `camera_${Date.now()}.${extension}`;
  const filePath = path.join(uploadDir, filename);

  const buffer = Buffer.from(matches[2], 'base64');
  fs.writeFileSync(filePath, buffer);

  return {
    path: filePath,
    filename: filename
  };
}

// ======================
// 7. ROUTES
// ======================
app.get('/', (req, res) => res.render('index'));

app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    let imagePath;
    let filename;

    // Handle camera image upload (base64)
    if (req.body.cameraImage) {
      const savedImage = saveBase64Image(req.body.cameraImage);
      imagePath = savedImage.path;
      filename = savedImage.filename;
    } 
    // Handle regular file upload
    else if (req.file) {
      imagePath = req.file.path;
      filename = req.file.filename;
    } 
    else {
      throw new Error('No image provided');
    }

    // Process and analyze the image
    const processedPath = await preprocessImage(imagePath);
    const text = await extractText(processedPath);
    const analysis = await analyzeIngredients(text);

    // Cleanup processed image (keep original)
    fs.unlinkSync(processedPath);

    // Render results
    res.render('result', {
      imagePath: `/uploads/${filename}`,
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