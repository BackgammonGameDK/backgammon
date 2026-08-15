/* Firebase project config for this game's Realtime Database.
 *
 * Safe to be public and committed: this identifies which project to talk
 * to, it isn't a secret. Security comes from database.rules.json (only
 * /rooms/<code> is readable/writable, and only if you already know the
 * code), not from hiding this file.
 */
firebase.initializeApp({
  projectId: 'backgammon-b66f6',
  appId: '1:1035500101425:web:1ac48183fae5be25381a10',
  databaseURL: 'https://backgammon-b66f6-default-rtdb.firebaseio.com',
  storageBucket: 'backgammon-b66f6.firebasestorage.app',
  apiKey: 'AIzaSyBnowDRQJ7DcXirbCh2ezWiUnTbcTc8FsY',
  authDomain: 'backgammon-b66f6.firebaseapp.com',
  messagingSenderId: '1035500101425',
});
