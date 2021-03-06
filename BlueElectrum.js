import AsyncStorage from '@react-native-community/async-storage';
const ElectrumClient = require('electrum-client');
let bitcoin = require('bitcoinjs-lib');
let reverse = require('buffer-reverse');

const storageKey = 'ELECTRUM_PEERS';
const defaultPeer = { host: 'electrum1.bluewallet.io', tcp: '50001' };
const hardcodedPeers = [
  // { host: 'noveltybobble.coinjoined.com', tcp: '50001' }, // down
  // { host: 'electrum.be', tcp: '50001' },
  // { host: 'node.ispol.sk', tcp: '50001' }, // down
  // { host: '139.162.14.142', tcp: '50001' },
  // { host: 'electrum.coinucopia.io', tcp: '50001' }, // SLOW
  // { host: 'Bitkoins.nl', tcp: '50001' }, // down
  // { host: 'fullnode.coinkite.com', tcp: '50001' },
  // { host: 'preperfect.eleCTruMioUS.com', tcp: '50001' }, // down
  { host: 'electrum1.bluewallet.io', tcp: '50001' },
  { host: 'electrum1.bluewallet.io', tcp: '50001' }, // 2x weight
  { host: 'electrum2.bluewallet.io', tcp: '50001' },
  { host: 'electrum3.bluewallet.io', tcp: '50001' },
  { host: 'electrum3.bluewallet.io', tcp: '50001' }, // 2x weight
];

let mainClient = false;
let mainConnected = false;

async function connectMain() {
  let usingPeer = await getRandomHardcodedPeer();
  try {
    console.log('begin connection:', JSON.stringify(usingPeer));
    mainClient = new ElectrumClient(usingPeer.tcp, usingPeer.host, 'tcp');
    await mainClient.connect();
    const ver = await mainClient.server_version('2.7.11', '1.4');
    let peers = await mainClient.serverPeers_subscribe();
    if (peers && peers.length > 0) {
      console.log('connected to ', ver);
      mainConnected = true;
      AsyncStorage.setItem(storageKey, JSON.stringify(peers));
    }
  } catch (e) {
    mainConnected = false;
    console.log('bad connection:', JSON.stringify(usingPeer), e);
  }

  if (!mainConnected) {
    console.log('retry');
    mainClient.keepAlive = () => {}; // dirty hack to make it stop reconnecting
    mainClient.reconnect = () => {}; // dirty hack to make it stop reconnecting
    mainClient.close();
    setTimeout(connectMain, 500);
  }
}

connectMain();

/**
 * Returns random hardcoded electrum server guaranteed to work
 * at the time of writing.
 *
 * @returns {Promise<{tcp, host}|*>}
 */
async function getRandomHardcodedPeer() {
  return hardcodedPeers[(hardcodedPeers.length * Math.random()) | 0];
}

/**
 * Returns random electrum server out of list of servers
 * previous electrum server told us. Nearly half of them is
 * usually offline.
 * Not used for now.
 *
 * @returns {Promise<{tcp: number, host: string}>}
 */
// eslint-disable-next-line
async function getRandomDynamicPeer() {
  try {
    let peers = JSON.parse(await AsyncStorage.getItem(storageKey));
    peers = peers.sort(() => Math.random() - 0.5); // shuffle
    for (let peer of peers) {
      let ret = {};
      ret.host = peer[1];
      for (let item of peer[2]) {
        if (item.startsWith('t')) {
          ret.tcp = item.replace('t', '');
        }
      }
      if (ret.host && ret.tcp) return ret;
    }

    return defaultPeer; // failed to find random client, using default
  } catch (_) {
    return defaultPeer; // smth went wrong, using default
  }
}

/**
 *
 * @param address {String}
 * @returns {Promise<Object>}
 */
async function getBalanceByAddress(address) {
  if (!mainClient) throw new Error('Electrum client is not connected');
  let script = bitcoin.address.toOutputScript(address);
  let hash = bitcoin.crypto.sha256(script);
  let reversedHash = Buffer.from(reverse(hash));
  let balance = await mainClient.blockchainScripthash_getBalance(reversedHash.toString('hex'));
  balance.addr = address;
  return balance;
}

/**
 *
 * @param address {String}
 * @returns {Promise<Array>}
 */
async function getTransactionsByAddress(address) {
  if (!mainClient) throw new Error('Electrum client is not connected');
  let script = bitcoin.address.toOutputScript(address);
  let hash = bitcoin.crypto.sha256(script);
  let reversedHash = Buffer.from(reverse(hash));
  let history = await mainClient.blockchainScripthash_getHistory(reversedHash.toString('hex'));
  return history;
}

async function getTransactionsFullByAddress(address) {
  let txs = await this.getTransactionsByAddress(address);
  let ret = [];
  for (let tx of txs) {
    let full = await mainClient.blockchainTransaction_get(tx.tx_hash, true);
    full.address = address;
    for (let input of full.vin) {
      // now we need to fetch previous TX where this VIN became an output, so we can see its amount
      let prevTxForVin = await mainClient.blockchainTransaction_get(input.txid, true);
      if (prevTxForVin && prevTxForVin.vout && prevTxForVin.vout[input.vout]) {
        input.value = prevTxForVin.vout[input.vout].value;
        // also, we extract destination address from prev output:
        if (prevTxForVin.vout[input.vout].scriptPubKey && prevTxForVin.vout[input.vout].scriptPubKey.addresses) {
          input.addresses = prevTxForVin.vout[input.vout].scriptPubKey.addresses;
        }
      }
    }

    for (let output of full.vout) {
      if (output.scriptPubKey && output.scriptPubKey.addresses) output.addresses = output.scriptPubKey.addresses;
    }
    full.inputs = full.vin;
    full.outputs = full.vout;
    delete full.vin;
    delete full.vout;
    delete full.hex; // compact
    delete full.hash; // compact
    ret.push(full);
  }

  return ret;
}

/**
 *
 * @param addresses {Array}
 * @param batchsize {Number}
 * @returns {Promise<{balance: number, unconfirmed_balance: number, addresses: object}>}
 */
async function multiGetBalanceByAddress(addresses, batchsize) {
  batchsize = batchsize || 100;
  if (!mainClient) throw new Error('Electrum client is not connected');
  let ret = { balance: 0, unconfirmed_balance: 0, addresses: {} };

  let chunks = splitIntoChunks(addresses, batchsize);
  for (let chunk of chunks) {
    let scripthashes = [];
    let scripthash2addr = {};
    for (let addr of chunk) {
      let script = bitcoin.address.toOutputScript(addr);
      let hash = bitcoin.crypto.sha256(script);
      let reversedHash = Buffer.from(reverse(hash));
      reversedHash = reversedHash.toString('hex');
      scripthashes.push(reversedHash);
      scripthash2addr[reversedHash] = addr;
    }

    let balances = await mainClient.blockchainScripthash_getBalanceBatch(scripthashes);

    for (let bal of balances) {
      ret.balance += +bal.result.confirmed;
      ret.unconfirmed_balance += +bal.result.unconfirmed;
      ret.addresses[scripthash2addr[bal.param]] = bal.result;
    }
  }

  return ret;
}

async function multiGetUtxoByAddress(addresses, batchsize) {
  batchsize = batchsize || 100;
  if (!mainClient) throw new Error('Electrum client is not connected');
  let ret = {};

  let chunks = splitIntoChunks(addresses, batchsize);
  for (let chunk of chunks) {
    let scripthashes = [];
    let scripthash2addr = {};
    for (let addr of chunk) {
      let script = bitcoin.address.toOutputScript(addr);
      let hash = bitcoin.crypto.sha256(script);
      let reversedHash = Buffer.from(reverse(hash));
      reversedHash = reversedHash.toString('hex');
      scripthashes.push(reversedHash);
      scripthash2addr[reversedHash] = addr;
    }

    let results = await mainClient.blockchainScripthash_listunspentBatch(scripthashes);

    for (let utxos of results) {
      ret[scripthash2addr[utxos.param]] = utxos.result;
      for (let utxo of ret[scripthash2addr[utxos.param]]) {
        utxo.address = scripthash2addr[utxos.param];
        utxo.txId = utxo.tx_hash;
        utxo.vout = utxo.tx_pos;
        delete utxo.tx_pos;
        delete utxo.tx_hash;
      }
    }
  }

  return ret;
}

async function multiGetHistoryByAddress(addresses, batchsize) {
  batchsize = batchsize || 100;
  if (!mainClient) throw new Error('Electrum client is not connected');
  let ret = {};

  let chunks = splitIntoChunks(addresses, batchsize);
  for (let chunk of chunks) {
    let scripthashes = [];
    let scripthash2addr = {};
    for (let addr of chunk) {
      let script = bitcoin.address.toOutputScript(addr);
      let hash = bitcoin.crypto.sha256(script);
      let reversedHash = Buffer.from(reverse(hash));
      reversedHash = reversedHash.toString('hex');
      scripthashes.push(reversedHash);
      scripthash2addr[reversedHash] = addr;
    }

    let results = await mainClient.blockchainScripthash_getHistoryBatch(scripthashes);

    for (let history of results) {
      ret[scripthash2addr[history.param]] = history.result;
      for (let hist of ret[scripthash2addr[history.param]]) {
        hist.address = scripthash2addr[history.param];
      }
    }
  }

  return ret;
}

async function multiGetTransactionByTxid(txids, batchsize) {
  batchsize = batchsize || 100;
  if (!mainClient) throw new Error('Electrum client is not connected');
  let ret = {};

  let chunks = splitIntoChunks(txids, batchsize);
  for (let chunk of chunks) {
    let results = await mainClient.blockchainTransaction_getBatch(chunk, true);

    for (let txdata of results) {
      ret[txdata.param] = txdata.result;
    }
  }

  return ret;
}

/**
 * Simple waiter till `mainConnected` becomes true (which means
 * it Electrum was connected in other function), or timeout 30 sec.
 *
 *
 * @returns {Promise<Promise<*> | Promise<*>>}
 */
async function waitTillConnected() {
  let waitTillConnectedInterval = false;
  let retriesCounter = 0;
  return new Promise(function(resolve, reject) {
    waitTillConnectedInterval = setInterval(() => {
      if (mainConnected) {
        clearInterval(waitTillConnectedInterval);
        resolve(true);
      }
      if (retriesCounter++ >= 30) {
        clearInterval(waitTillConnectedInterval);
        reject(new Error('Waiting for Electrum connection timeout'));
      }
    }, 1000);
  });
}

async function estimateFees() {
  if (!mainClient) throw new Error('Electrum client is not connected');
  const fast = await mainClient.blockchainEstimatefee(1);
  const medium = await mainClient.blockchainEstimatefee(5);
  const slow = await mainClient.blockchainEstimatefee(10);
  return { fast, medium, slow };
}

async function broadcast(hex) {
  if (!mainClient) throw new Error('Electrum client is not connected');
  try {
    const broadcast = await mainClient.blockchainTransaction_broadcast(hex);
    return broadcast;
  } catch (error) {
    return error;
  }
}

module.exports.getBalanceByAddress = getBalanceByAddress;
module.exports.getTransactionsByAddress = getTransactionsByAddress;
module.exports.multiGetBalanceByAddress = multiGetBalanceByAddress;
module.exports.getTransactionsFullByAddress = getTransactionsFullByAddress;
module.exports.waitTillConnected = waitTillConnected;
module.exports.estimateFees = estimateFees;
module.exports.broadcast = broadcast;
module.exports.multiGetUtxoByAddress = multiGetUtxoByAddress;
module.exports.multiGetHistoryByAddress = multiGetHistoryByAddress;
module.exports.multiGetTransactionByTxid = multiGetTransactionByTxid;

module.exports.forceDisconnect = () => {
  mainClient.keepAlive = () => {}; // dirty hack to make it stop reconnecting
  mainClient.reconnect = () => {}; // dirty hack to make it stop reconnecting
  mainClient.close();
};

module.exports.hardcodedPeers = hardcodedPeers;

let splitIntoChunks = function(arr, chunkSize) {
  let groups = [];
  let i;
  for (i = 0; i < arr.length; i += chunkSize) {
    groups.push(arr.slice(i, i + chunkSize));
  }
  return groups;
};

/*



let addr4elect = 'bc1qwqdg6squsna38e46795at95yu9atm8azzmyvckulcc7kytlcckxswvvzej';
let script = bitcoin.address.toOutputScript(addr4elect);
let hash = bitcoin.crypto.sha256(script);
let reversedHash = Buffer.from(hash.reverse());
console.log(addr4elect, ' maps to ', reversedHash.toString('hex'));
console.log(await mainClient.blockchainScripthash_getBalance(reversedHash.toString('hex')));

addr4elect = '1BWwXJH3q6PRsizBkSGm2Uw4Sz1urZ5sCj';
script = bitcoin.address.toOutputScript(addr4elect);
hash = bitcoin.crypto.sha256(script);
reversedHash = Buffer.from(hash.reverse());
console.log(addr4elect, ' maps to ', reversedHash.toString('hex'));
console.log(await mainClient.blockchainScripthash_getBalance(reversedHash.toString('hex')));

// let peers = await mainClient.serverPeers_subscribe();
// console.log(peers);
mainClient.keepAlive = () => {}; // dirty hack to make it stop reconnecting
mainClient.reconnect = () => {}; // dirty hack to make it stop reconnecting
mainClient.close();
// setTimeout(()=>process.exit(), 3000); */
