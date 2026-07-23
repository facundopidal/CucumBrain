import fs from 'fs';
import path from 'path';
import os from 'os';

const engramDir = path.join(os.homedir(), '.engram');
console.log('Engram Dir:', engramDir);
try {
  if (fs.existsSync(engramDir)) {
    const files = fs.readdirSync(engramDir);
    console.log('Files in ~/.engram:', files);
  } else {
    console.log('~/.engram does not exist');
  }
} catch (err) {
  console.error(err);
}
