import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

async function generatePDF() {
  return new Promise((resolve, reject) => {
    const publicDir = path.join(process.cwd(), 'public');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir);
    }

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const writeStream = fs.createWriteStream(path.join(publicDir, 'rutvik_dangar_resume.pdf'));
    
    doc.pipe(writeStream);
    
    writeStream.on('finish', () => {
      console.log('Real PDF written successfully to public/.');
      const distDir = path.join(process.cwd(), 'dist');
      if (fs.existsSync(distDir)) {
        try {
          fs.copyFileSync(
            path.join(publicDir, 'rutvik_dangar_resume.pdf'),
            path.join(distDir, 'rutvik_dangar_resume.pdf')
          );
          console.log('Real PDF copied to dist/ successfully.');
        } catch (copyErr) {
          console.error('Failed to copy to dist/:', copyErr);
        }
      }
      resolve(true);
    });
    
    writeStream.on('error', (err) => {
      console.error('Error writing PDF:', err);
      reject(err);
    });

    // Generate content
    doc.font('Helvetica-Bold').fontSize(20).text('DANGAR RUTVIKKUMAR ALPESHBHAI', { align: 'center' });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(10).text('Email: rutvikdangar20@gmail.com | Location: Ahmedabad, Gujarat', { align: 'center' });
    doc.moveDown(2);

    doc.font('Helvetica-Bold').fontSize(14).text('Professional Summary');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).text('An analytical and highly motivated Bachelor of Business Administration (BBA) student specializing in Marketing (Semester 5). Possesses an empirical foundation in Management Information Systems (MIS), corporate financial structures, and consumer buying trends. Proven competency in drafting comprehensive business research models, analyzing data, and translating market parameters into core corporate strategies. Seeking to leverage academic research experience and modern marketing literacy in a progressive business environment.', { align: 'justify' });
    doc.moveDown(1.5);

    doc.font('Helvetica-Bold').fontSize(14).text('Education');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').fontSize(11).text('Bachelor of Business Administration (BBA) — Marketing Specialization', { continued: true }).text('2024 — Present (Semester 5)', { align: 'right' });
    doc.font('Helvetica-Oblique').fontSize(10).text('Ahmedabad Institute of Business Management (AIBM)');
    doc.font('Helvetica').fontSize(10).text('Focusing on Consumer Behaviour architecture, Operational Planning, Brand Strategy, Business Analytics, and Management Information Systems (MIS).', { align: 'justify' });
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(11).text('Higher Secondary Certificate (HSC — Class XII)', { continued: true }).text('March 2024', { align: 'right' });
    doc.font('Helvetica-Oblique').fontSize(10).text('Gujarat Secondary and Higher Secondary Education Board, Gandhinagar');
    doc.font('Helvetica-Bold').fontSize(10).text('Percentile Rank: 68 PR');
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(11).text('Secondary School Certificate (SSC — Class X)', { continued: true }).text('March 2022', { align: 'right' });
    doc.font('Helvetica-Oblique').fontSize(10).text('Gujarat Secondary and Higher Secondary Education Board, Gandhinagar');
    doc.font('Helvetica-Bold').fontSize(10).text('Percentile Rank: 76 PR');
    doc.moveDown(1.5);

    doc.font('Helvetica-Bold').fontSize(14).text('Academic & Business Projects');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').fontSize(11).text('Business Research Methods (BRM) Project: College Students Buying Behaviour');
    doc.font('Helvetica-Oblique').fontSize(10).text('Lead Researcher & Analyst');
    doc.font('Helvetica').fontSize(10).list(['Formulated structural research criteria to evaluate product preferences, brand loyalty patterns, and purchasing triggers among student segments.', 'Compiled qualitative data arrays to identify consumer price elasticity, reliance on digital commerce infrastructure, and regional brand-switching activities.']);
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(11).text('Financial Management Analysis: Dairy Sector Leader (Amul)');
    doc.font('Helvetica-Oblique').fontSize(10).text('Market Analyst & Project Contributor');
    doc.font('Helvetica').fontSize(10).list(['Evaluated capital frameworks, working capital cycles, and operational asset distributions of GCMMF (Amul) within the FMCG ecosystem.', 'Assessed integration mechanics of perishable supply chain systems scaling into emerging Quick-Commerce distribution nodes.']);
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(11).text('Project Aura & Advanced Automation Frameworks');
    doc.font('Helvetica-Oblique').fontSize(10).text('System Logic Design & Prompt Architect');
    doc.font('Helvetica').fontSize(10).list(['Engineered context-handling frameworks and conversational parameters optimization for voice-first automation companions (Aura, Bella AI, Maya).', 'Mapped semantic logic configurations to handle regional multi-dialect code-switching interactions smoothly.']);
    doc.moveDown(1.5);

    doc.font('Helvetica-Bold').fontSize(14).text('Core Competencies & Professional Skills');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').fontSize(10).text('Marketing & Strategy: ', { continued: true }).font('Helvetica').text('Consumer Behaviour Tracking, Brand Architecture Foundations, Market Friction Analysis');
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(10).text('Management & Systems: ', { continued: true }).font('Helvetica').text('Business Research Models, Management Information Systems (MIS), Project Planning');
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(10).text('Technical Competencies: ', { continued: true }).font('Helvetica').text('Conversational Architecture Principles, MS Excel Data Records, Flow-Logic Maps');
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(10).text('Languages Known: ', { continued: true }).font('Helvetica').text('English, Hindi, Gujarati');

    doc.end();
  });
}

generatePDF().then(() => console.log('Done'));
