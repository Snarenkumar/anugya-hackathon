const express = require('express');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const app = express();

// ======================
// 1. BASIC SETUP
// ======================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// ======================
// 2. FILE UPLOAD CONFIG
// ======================
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
  }),
  fileFilter: (req, file, cb) => {
    const validTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    cb(null, validTypes.includes(file.mimetype));
  },
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// ======================
// 3. IMAGE PROCESSING
// ======================
async function preprocessImage(imagePath) {
  const processedPath = path.join(uploadDir, 'processed_' + path.basename(imagePath));
  
  await sharp(imagePath)
    .greyscale()
    .normalise()
    .linear(1.1) // Increase contrast
    .sharpen()
    .toFile(processedPath);

  return processedPath;
}

// ======================
// 4. OCR PROCESSING
// ======================
async function extractText(imagePath) {
  const { data: { text } } = await Tesseract.recognize(
    imagePath,
    'eng',
    {
      logger: m => console.log(m.status),
      tessedit_pageseg_mode: 6,
      preserve_interword_spaces: 1
    }
  );
  return text;
}

// ======================
// 5. ROUTES
// ======================
app.get('/', (req, res) => res.render('index'));

app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) throw new Error('Please upload an image file');

    // Process image
    const processedPath = await preprocessImage(req.file.path);
    
    // Extract text
    const text = await extractText(processedPath);
    
    // Cleanup files
    fs.unlinkSync(processedPath); // Remove processed image
    
    // Send response
    res.render('result', {
      imagePath: `/uploads/${path.basename(req.file.filename)}`,
      extractedText: text.trim()
    });

  } catch (err) {
    console.error('Error:', err);
    res.status(500).render('error', { 
      message: err.message || 'Failed to process image'
    });
  }
});

// ======================
// 6. START SERVER
// ======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Upload directory: ${uploadDir}`);
});