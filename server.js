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
//new
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
    // { logger: m => console.log(m.status) }
  );
  return text;
}

// 5. GEMINI ANALYSIS (Updated prompt)
async function analyzeIngredients(ingredients) {
  try {
    const prompt = `Analyze these food ingredients and provide a concise 4-line response: give user friendly word not complex words, and dont repeat same things
    1. Key ingredients detected (top 3-4)
    2. Safety assessment based on FSSAI/WHO guidelines , give proper suggestion for at least 2 or 3 sentence, no complex words, simple to understand, which they need to follow.
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

// Add this new function in your server.js (around line 70)
async function detailedAnalysis(ingredients, productName) {
  try {
    const prompt = `Analyze the food product "${productName}" for a comprehensive health assessment. Provide:
    
    1. Ingredient Breakdown (as JSON arrays):
       - positiveIngredients: [{name: string, benefit: string}], so it must include min 5 points, its ok even if no ingridients are there, just include its general information
       - negativeIngredients: [{name: string, concern: string}], so it must include min 5 points,its ok even if no ingridients are there, just include its general information
    
    2. Safety Evaluation:
       - safetyRating: number (1-10)
       - safetyExplanation: string
    
    3. Harmful Chemicals:
       - harmfulChemicals: [{name: string, commonUses: string, healthImpact: string}]
    
    4. Consumption Recommendation:
       - recommendation: string
       - recommendationReason: string
    
    Ingredients: ${ingredients.substring(0, 5000)}
    
    Format response as JSON. Use simple language.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    return JSON.parse(text.replace(/```json|```/g, ''));
  } catch (err) {
    console.error('Detailed Analysis Error:', err);
    throw new Error('Detailed analysis failed');
  }
}

// Update your /final route (around line 140)
// In your server.js file, update the /final route:
app.get('/final', async (req, res) => {
  try {
    const analysis = JSON.parse(decodeURIComponent(req.query.analysis));
    const imagePath = req.query.imagePath;
    
    // Ensure we have all required data
    if (!analysis.safetyRating || typeof analysis.safetyRating.score === 'undefined') {
      throw new Error('Invalid analysis data');
    }

    // Transform the data structure if needed
    const detailedAnalysis = {
      safetyRating: analysis.safetyRating.score,
      safetyExplanation: analysis.safetyRating.explanation,
      positiveIngredients: analysis.keyIngredients.map(ing => ({
        name: ing,
        benefit: `Natural ingredient found in ${ing.toLowerCase().includes('oil') ? 'healthy foods' : 'many foods'}`
      })),
      negativeIngredients: analysis.harmfulChemicals.map(chem => ({
        name: chem,
        concern: 'Potential health risks with regular consumption'
      })),
      harmfulChemicals: analysis.harmfulChemicals.map(chem => ({
        name: chem,
        commonUses: getCommonUses(chem),
        healthImpact: getHealthImpact(chem)
      })),
      recommendationReason: analysis.safetyAssessment || 'Based on ingredient analysis'
    };

    res.render('final', {
      imagePath: imagePath,
      basicAnalysis: {
        productName: analysis.productName || 'Scanned Product'
      },
      detailedAnalysis: detailedAnalysis
    });
  } catch (err) {
    console.error('Error in final route:', err);
    res.status(500).render('error', { message: 'Error displaying detailed results' });
  }
});

// Helper functions
function getCommonUses(chemical) {
  const uses = {
    'Trans Fats': 'Used in processed foods to extend shelf life',
    'High Levels of Saturated Fat': 'Found in fried and processed foods',
    'Artificial Flavors/Additives': 'Enhance taste and appearance in processed foods',
    'MSG': 'Flavor enhancer in many packaged foods'
  };
  return uses[chemical] || 'Common food additive';
}

function getHealthImpact(chemical) {
  const impacts = {
    'Trans Fats': 'Increases bad cholesterol and heart disease risk',
    'High Levels of Saturated Fat': 'Can raise cholesterol levels',
    'Artificial Flavors/Additives': 'Potential unknown long-term effects',
    'MSG': 'May cause headaches in sensitive individuals'
  };
  return impacts[chemical] || 'Potential health concerns with regular consumption';
}

// 6. ROUTES


app.get('/', (req, res) => {
  res.render('homepage', {
      title: 'ANUGYA',
      appName: 'ANUGYA',
      tagline: 'YOUR HEALTH SCANNER',
      description: 'Building a web application to scan packaged food products to know the ingredients and suitability to consume according to user health conditions and many more features.',
      workflowSteps: [
          {
              image: '/assets/Frame.png',
              title: 'UPLOAD',
              description: 'Upload an image of a packaged food product to analyze its ingredients.'
          },
          {
              image: '/assets/IMAGE (2).png',
              title: 'GET RESULT',
              description: 'AI scans and detects the ingredients, highlighting potential health risks.'
          },
          {
              image: '/assets/IMAGE (3).png',
              title: 'PERSONAL ADVICE',
              description: 'Receive a health rating, consumption recommendations, and better alternatives.'
          }
      ],
      ctaText: 'GET STARTED'
  });
});
app.get('/upload', (req, res) => res.render('index'));

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


// Mood-based food recommendations route
app.post('/get-mood-food-recommendations', async (req, res) => {
  try {
    const { mood } = req.body;
   
    if (!mood) {
      return res.status(400).json({ error: 'Mood is required' });
    }
   
    // Construct the prompt for Gemini API
    const prompt = `Provide 10-15 healthy food recommendations that help with ${mood} mood.
    For each food, include a brief explanation of how it helps with this specific mood.
    Format the response as a JSON object with a "foods" array where each item has "name" and "benefits" properties.
    Also include an "additionalTips" property with general dietary advice for this mood.
   
    Example format:
    {
      "foods": [
        {
          "name": "Dark Chocolate",
          "benefits": "Contains flavonoids that may improve mood by increasing serotonin levels"
        }
      ],
      "additionalTips": "Stay hydrated and maintain regular meal times"
    }`;
   
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
   
    // Clean the response and parse as JSON
    const cleanText = text.replace(/```json|```/g, '');
    const recommendations = JSON.parse(cleanText);
   
    res.json(recommendations);
   
  } catch (err) {
    console.error('Mood Food Recommendation Error:', err);
    res.status(500).json({ error: 'Failed to generate food recommendations' });
  }
});



