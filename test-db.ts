import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';
import * as fs from 'fs';

const config = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));
const app = initializeApp(config);
const db = getFirestore(app, config.firestoreDatabaseId);

async function run() {
  try {
    const docRef = doc(db, 'settings', 'admin_config');
    await setDoc(docRef, { password: '123456' }, { merge: true });
    console.log("Successfully updated admin_config password in Firestore to 123456!");
  } catch (e) {
    console.error("ERROR updating password: ", e);
  }
}
run();
