import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Define paths
const schemasDir = join(__dirname, 'schemas');
const outputFile = join(__dirname, 'schema.prisma');

// Read all .prisma files from the schemas directory
const schemaFiles = readdirSync(schemasDir).filter(file => file.endsWith('.prisma'));

// Ensure base.prisma is at the top, then include all other files
const baseFile = 'base.prisma';
let combinedContent = '';

if (schemaFiles.includes(baseFile)) {
  // Add base.prisma first
  combinedContent += readFileSync(join(schemasDir, baseFile), 'utf8') + '\n';
} else {
  console.warn('Warning: base.prisma not found in schemas directory');
}

// Add all remaining .prisma files (excluding base.prisma)
const otherFiles = schemaFiles.filter(file => file !== baseFile);
if (otherFiles.length > 0) {
  const otherContent = otherFiles
    .map(file => readFileSync(join(schemasDir, file), 'utf8'))
    .join('\n');
  combinedContent += otherContent;
} else {
  console.warn('Warning: No additional .prisma files found in schemas directory');
}

// Write the combined schema to schema.prisma
writeFileSync(outputFile, combinedContent.trim());

console.log('Prisma schema combined successfully!');