require('dotenv').config();
const express = require('express');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs');

const app = express();

// 1. GEMINI AI INIT
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-1.5-flash",
  apiVersion: "v1"
});

// 2. APP CONFIGURATION
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// 3. FILE UPLOAD SETUP
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
  }),
  fileFilter: (req, file, cb) => {
    const validTypes = ['image/jpeg', 'image/png', 'image/webp'];
    cb(null, validTypes.includes(file.mimetype));
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

// 4. IMAGE PROCESSING
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

// 5. GEMINI ANALYSIS (Updated prompt)
async function analyzeIngredients(ingredients) {
  try {
    const prompt = `Analyze these food ingredients and provide a concise 4-line response:
    1. Key ingredients detected (top 3-4)
    2. Safety assessment based on FSSAI/WHO guidelines (3 sentences max)
    3. 1-10 safety rating with brief explanation
    4. Harmful chemicals detection (if any)
    
    Ingredients: ${ingredients.substring(0, 5000)}
    
    Format response as JSON:
    {
      "productName": "string",
      "keyIngredients": ["list"],
      "safetyAssessment": "string",
      "safetyRating": {
        "score": number,
        "explanation": "string"
      },
      "harmfulChemicals": ["list"] 
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

// 6. ROUTES
app.get('/', (req, res) => res.render('index'));

app.post('/detail', upload.single('image'), async (req, res) => {
  try {
    let imagePath;
    let filename;

    if (req.file) {
      // Handle file upload
      imagePath = req.file.path;
      filename = req.file.filename;
    } else if (req.body.cameraImage) {
      // Handle camera capture (base64)
      const matches = req.body.cameraImage.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!matches) throw new Error('Invalid image data');
      
      const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
      filename = `camera_${Date.now()}.${ext}`;
      imagePath = path.join(uploadDir, filename);
      
      await fs.promises.writeFile(imagePath, matches[2], 'base64');
    } else {
      throw new Error('No image data received');
    }

    // Process and analyze the image
    const processedPath = await preprocessImage(imagePath);
    const text = await extractText(processedPath);
    const analysis = await analyzeIngredients(text);

    // Cleanup
    fs.unlinkSync(processedPath);

    // Render the initial view with image and brief analysis
    res.render('detail', {
      imagePath: `/uploads/${filename}`,
      analysis: analysis
    });
    
  } catch (err) {
    console.error('Upload Error:', err);
    res.status(500).render('error', { 
      message: err.message.includes('AI analysis') ? 
               'AI analysis failed. Please try again with clearer text.' : 
               err.message
    });
  }
});

// Route for detailed view
app.get('/final', (req, res) => {
  try {
    const analysis = JSON.parse(decodeURIComponent(req.query.analysis));
    res.render('final', {
      imagePath: req.query.imagePath,
      analysis: analysis
    });
  } catch (err) {
    res.status(500).render('error', { message: 'Error displaying results' });
  }
});

// 7. START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));