import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = name => fileURLToPath(new URL(name, import.meta.url));
const assets = '../../../assets/near-fox/';
const sdk = here('./node_modules/@near-wallet-selector/intear-wallet/index.js');
const source = readFileSync(sdk, 'utf8');
const icon = source.match(/var icon = "data:image\/svg\+xml;base64,([^"]+)"/);
if (!icon) throw new Error('Intear logo is missing from the SDK.');
writeFileSync(here(assets + 'intear-logo.svg'), Buffer.from(icon[1], 'base64'));

const start = source.indexOf('const iframe = document.createElement("iframe");\n          iframe.src =');
const end = source.indexOf('    signOut() {', start);
if (start < 0 || end < 0) throw new Error('Intear connector entry point changed.');
const original = source.slice(start, end);
function replaceRequired(value, match, replacement) {
  if (!value.includes(match)) throw new Error('Intear SDK entry point changed: ' + match);
  return value.replace(match, () => replacement);
}
const connector = original
  .replace('iframe.src = `${iframeOriginUrl}/wallet-connector-iframe.html`;', [
    'const connectorUrl = new URL("./wallet-connector-iframe.html", import.meta.url);',
    '          iframe.src = connectorUrl.href;',
    '          iframe.title = "Connect Intear Wallet";',
  ].join('\n'))
  .replaceAll('}, iframeOriginUrl);', '}, connectorUrl.origin);')
  .replace('logger.log("Message from connect popup", event);',
    'if (event.source !== iframe.contentWindow || event.origin !== connectorUrl.origin || !event.data) return;')
  .replace('case "connected":\n                let accounts', 'case "connected":\n                if (!event.data.accounts?.length) {\n                  window.removeEventListener("message", listener);\n                  iframe.remove();\n                  reject(new Error("No account connected."));\n                  break;\n                }\n                let accounts')
  .replace(/\(_b = iframe\.contentWindow\)[\s\S]*?}, connectorUrl\.origin\);/, [
    'gameConnector = iframe;',
    '                gameWalletPopup = iframe.contentWindow.takeGameWalletPopup?.();',
    '                window.removeEventListener("message", listener);',
  ].join('\n'));
if (!connector.includes('connectorUrl.href') || !connector.includes('event.source !==') || connector.includes('}, iframeOriginUrl);')) {
  throw new Error('Could not attach the game connector to the Intear SDK.');
}

const factory = 'walletUrl: iframeOriginUrl\n}) => {\n  return Promise.resolve({\n    signIn({';
let gameSdk = source.slice(0, start) + connector + source.slice(end);
if (!connector.includes('takeGameWalletPopup')) throw new Error('Intear connected handler changed.');
gameSdk = replaceRequired(gameSdk, factory, [
  'walletUrl: iframeOriginUrl',
  '}) => {',
  '  let gameConnector, gameWalletPopup;',
  '  return Promise.resolve({',
  '    closeGameConnector() {',
  '      gameWalletPopup?.close();',
  '      gameConnector?.remove();',
  '      gameWalletPopup = gameConnector = null;',
  '    },',
  '    signIn({',
].join('\n'));

const signStart = gameSdk.indexOf('const popup = window.open(`${savedData.walletUrl}/sign-message`');
const signEnd = gameSdk.indexOf('    signAndSendTransaction({', signStart);
if (signStart < 0 || signEnd < 0) throw new Error('Intear signature popup entry point changed.');
let signer = gameSdk.slice(signStart, signEnd);
signer = replaceRequired(signer, 'const popup = window.open(`${savedData.walletUrl}/sign-message`, "_blank", POPUP_FEATURES);', [
  'const walletOrigin = new URL(savedData.walletUrl).origin;',
  '            const popup = gameWalletPopup;',
  '            const messageTarget = gameConnector?.contentWindow;',
  '            if (popup?.closed || !messageTarget) throw new Error("Wallet popup closed. Connect Intear to try again.");',
].join('\n'));
signer = replaceRequired(signer, 'logger.log("Message from sign-message popup", event);',
  'if (event.source !== popup || event.origin !== walletOrigin || !event.data) return;');
signer = replaceRequired(signer, 'done = true;\n                    popup.close();\n                    const signature = event.data.signature;', [
  'done = true;',
  '                    const signature = event.data.signature;',
  '                    if (typeof signature?.signature !== "string") {',
  '                      reject(new Error("Intear did not return a signature."));',
  '                      break;',
  '                    }',
].join('\n'));
const encodeSignature = 'btoa(Array.from(baseDecode(signature.signature.split(":")[1]), byte => String.fromCharCode(byte)).join(""))';
signer = replaceRequired(signer, encodeSignature,
  'signature.signature.startsWith("ed25519:") ? ' + encodeSignature + ' : signature.signature');
signer = replaceRequired(signer, 'window.addEventListener("message", listener);', [
  'messageTarget.addEventListener("message", listener);',
  '            popup.location.href = walletOrigin + "/sign-message";',
  '            popup.focus();',
].join('\n'));
signer = replaceRequired(signer, 'window.removeEventListener("message", listener);',
  'messageTarget.removeEventListener("message", listener);');
gameSdk = gameSdk.slice(0, signStart) + signer + gameSdk.slice(signEnd);

await build({
  entryPoints: [here('./game-wallet-entry.js')],
  outfile: here(assets + 'intear-wallet.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  legalComments: 'eof',
  plugins: [{
    name: 'game-intear-connector',
    setup(builder) {
      builder.onLoad({ filter: /[/\\]intear-wallet[/\\]index\.js$/ }, args => {
        if (args.path !== sdk) return;
        return { contents: gameSdk, loader: 'js' };
      });
    },
  }],
});
