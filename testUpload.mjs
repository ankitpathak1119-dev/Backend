import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';

async function testUpload() {
  try {
    const formData = new FormData();
    formData.append('file', fs.createReadStream('package.json'));
    formData.append('from', 'test');
    formData.append('chatId', '123');
    formData.append('chatType', 'private');

    const res = await fetch('https://backend-t3si.onrender.com/upload', {
      method: 'POST',
      body: formData,
    });

    const text = await res.text();
    console.log('Status:', res.status);
    console.log('Response:', text);
  } catch (e) {
    console.error('Error:', e);
  }
}

testUpload();
