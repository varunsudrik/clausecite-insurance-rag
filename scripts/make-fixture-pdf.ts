// Generates data/fixtures/sample-policy.pdf — a synthetic policy wording used by tests.
// Usage: pnpm fixtures:pdf
import { mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';

type Block = { kind: 'title' | 'section' | 'clause' | 'body'; text: string };

const PAGES: Block[][] = [
  [
    { kind: 'title', text: 'SAMPLE HEALTH SHIELD POLICY WORDING' },
    { kind: 'section', text: 'Section A: Definitions' },
    { kind: 'clause', text: 'A.1 Hospital' },
    { kind: 'body', text: 'Hospital means any institution established for in-patient care and day care treatment of illness and injuries which has been registered as a hospital with the local authorities and has at least 10 in-patient beds.' },
    { kind: 'clause', text: 'A.2 Pre-existing Disease' },
    { kind: 'body', text: 'Pre-existing Disease means any condition, ailment, injury or disease that is diagnosed by a physician within 36 months prior to the date of commencement of the policy.' },
    { kind: 'section', text: 'Section B: Coverage' },
    { kind: 'clause', text: 'B.1 In-patient Hospitalisation' },
    { kind: 'body', text: 'The Company shall indemnify medical expenses for in-patient care for a minimum period of 24 consecutive hours, subject to the sum insured.' },
  ],
  [
    { kind: 'clause', text: 'B.2 Room Rent' },
    { kind: 'body', text: 'Room rent, boarding and nursing expenses are covered up to 1% of the sum insured per day, subject to a maximum of Rs 5,000 per day. ICU charges are covered up to 2% of the sum insured per day.' },
    { kind: 'clause', text: 'B.3 Day Care Treatment' },
    { kind: 'body', text: 'Expenses for day care procedures listed in Annexure I are covered up to the sum insured.' },
    { kind: 'section', text: 'Section C: Exclusions' },
    { kind: 'clause', text: 'C.1 Initial Waiting Period' },
    { kind: 'body', text: 'Expenses related to the treatment of any illness within 30 days from the first policy commencement date are excluded, except claims arising due to an accident.' },
  ],
  [
    { kind: 'clause', text: 'C.2 Pre-existing Diseases' },
    { kind: 'body', text: 'Expenses related to the treatment of a pre-existing disease and its direct complications are excluded until the expiry of 36 months of continuous coverage after the date of inception of the first policy.' },
    { kind: 'clause', text: 'C.2.1 Disclosure' },
    { kind: 'body', text: 'Coverage of pre-existing diseases is subject to the disease being declared in the proposal form and accepted by the Company.' },
    { kind: 'clause', text: 'C.3 Specified Disease Waiting Period' },
    { kind: 'body', text: 'The following procedures are covered only after 24 months of continuous coverage: (i) cataract; (ii) knee replacement; (iii) hernia.' },
  ],
  [
    { kind: 'section', text: 'Section D: General Conditions' },
    { kind: 'clause', text: 'D.1 Free Look Period' },
    { kind: 'body', text: 'The policyholder may cancel the policy within 15 days of receipt of the policy document if not satisfied with the terms and conditions.' },
    { kind: 'clause', text: 'D.2 Claim Intimation' },
    { kind: 'body', text: 'Any claim must be intimated to the Company within 48 hours of admission in case of emergency hospitalisation.' },
  ],
];

const STYLE = {
  title: { size: 16, bold: true, gapBefore: 0 },
  section: { size: 13, bold: true, gapBefore: 14 },
  clause: { size: 11, bold: true, gapBefore: 10 },
  body: { size: 10, bold: false, gapBefore: 2 },
} as const;

function wrap(text: string, maxChars = 95): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if ((line + ' ' + word).trim().length > maxChars) {
      out.push(line.trim());
      line = word;
    } else line += ' ' + word;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

const pdf = await PDFDocument.create();
const regular = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

PAGES.forEach((blocks, i) => {
  const page = pdf.addPage([595, 842]);
  page.drawText('Sample Health Shield - Policy Wording', { x: 50, y: 810, size: 9, font: regular });
  page.drawText(`Page ${i + 1} of ${PAGES.length}`, { x: 270, y: 30, size: 9, font: regular });
  let y = 770;
  for (const b of blocks) {
    const s = STYLE[b.kind];
    y -= s.gapBefore;
    for (const line of b.kind === 'body' ? wrap(b.text) : [b.text]) {
      page.drawText(line, { x: 50, y, size: s.size, font: s.bold ? bold : regular });
      y -= s.size + 4;
    }
  }
});

mkdirSync('data/fixtures', { recursive: true });
writeFileSync('data/fixtures/sample-policy.pdf', await pdf.save());
console.log('wrote data/fixtures/sample-policy.pdf');
