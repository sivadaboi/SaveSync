import dgram from 'dgram';
import os from 'os';

const DEFAULT_PORT = 8386;
const port = Number.parseInt(process.argv.find(arg => /^\d+$/.test(arg)) || DEFAULT_PORT, 10);
const shouldDelete = process.argv.includes('--delete') || process.argv.includes('delete');
const description = 'SaveSync WAN Relay';

function getLocalIPv4() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address)) {
        return entry.address;
      }
    }
  }
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

function isPrivateIPv4(ip) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(ip);
}

function discoverGateway(timeoutMs = 5000) {
  const request = [
    'M-SEARCH * HTTP/1.1',
    'HOST: 239.255.255.250:1900',
    'MAN: "ssdp:discover"',
    'MX: 2',
    'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
    '',
    ''
  ].join('\r\n');

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('No UPnP Internet Gateway Device responded.'));
    }, timeoutMs);

    socket.on('message', (message) => {
      const text = message.toString();
      const location = text.match(/^location:\s*(.+)$/im)?.[1]?.trim();
      if (!location) return;
      clearTimeout(timer);
      socket.close();
      resolve(location);
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });

    socket.bind(() => {
      socket.setMulticastTTL(2);
      socket.send(Buffer.from(request), 1900, '239.255.255.250');
    });
  });
}

function resolveUrl(base, maybeRelative) {
  return new URL(maybeRelative, base).toString();
}

async function getControlEndpoint(deviceDescriptionUrl) {
  const response = await fetch(deviceDescriptionUrl);
  if (!response.ok) throw new Error(`Could not read gateway description: HTTP ${response.status}`);
  const xml = await response.text();

  const serviceRegex = /<service>([\s\S]*?)<\/service>/gi;
  let match;
  while ((match = serviceRegex.exec(xml))) {
    const block = match[1];
    const serviceType = block.match(/<serviceType>(.*?)<\/serviceType>/i)?.[1]?.trim();
    const controlURL = block.match(/<controlURL>(.*?)<\/controlURL>/i)?.[1]?.trim();
    if (!serviceType || !controlURL) continue;
    if (serviceType.includes('WANIPConnection') || serviceType.includes('WANPPPConnection')) {
      return {
        serviceType,
        controlUrl: resolveUrl(deviceDescriptionUrl, controlURL)
      };
    }
  }

  throw new Error('Router responded, but no WANIPConnection/WANPPPConnection UPnP service was found.');
}

async function soap(controlUrl, serviceType, action, body) {
  const envelope = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">
      ${body}
    </u:${action}>
  </s:Body>
</s:Envelope>`;

  const response = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${serviceType}#${action}"`
    },
    body: envelope
  });

  const text = await response.text();
  if (!response.ok) {
    const fault = text.match(/<errorDescription>(.*?)<\/errorDescription>/i)?.[1] || `HTTP ${response.status}`;
    throw new Error(`${action} failed: ${fault}`);
  }
  return text;
}

async function getExternalIp(endpoint) {
  try {
    const text = await soap(endpoint.controlUrl, endpoint.serviceType, 'GetExternalIPAddress', '');
    return text.match(/<NewExternalIPAddress>(.*?)<\/NewExternalIPAddress>/i)?.[1] || null;
  } catch {
    return null;
  }
}

async function addMapping(endpoint, localIp) {
  await soap(endpoint.controlUrl, endpoint.serviceType, 'AddPortMapping', `
<NewRemoteHost></NewRemoteHost>
<NewExternalPort>${port}</NewExternalPort>
<NewProtocol>TCP</NewProtocol>
<NewInternalPort>${port}</NewInternalPort>
<NewInternalClient>${localIp}</NewInternalClient>
<NewEnabled>1</NewEnabled>
<NewPortMappingDescription>${description}</NewPortMappingDescription>
<NewLeaseDuration>0</NewLeaseDuration>`);
}

async function deleteMapping(endpoint) {
  await soap(endpoint.controlUrl, endpoint.serviceType, 'DeletePortMapping', `
<NewRemoteHost></NewRemoteHost>
<NewExternalPort>${port}</NewExternalPort>
<NewProtocol>TCP</NewProtocol>`);
}

async function main() {
  const localIp = getLocalIPv4();
  if (!localIp) throw new Error('Could not find a local IPv4 address for this PC.');

  console.log(`SaveSync UPnP port ${shouldDelete ? 'removal' : 'forwarding'} helper`);
  console.log(`Local PC: ${localIp}`);
  console.log(`TCP port: ${port}`);
  console.log('Searching for router UPnP service...');

  const gatewayUrl = await discoverGateway();
  console.log(`Router description: ${gatewayUrl}`);

  const endpoint = await getControlEndpoint(gatewayUrl);
  console.log(`Router control service: ${endpoint.serviceType}`);

  if (shouldDelete) {
    await deleteMapping(endpoint);
    console.log(`Removed TCP ${port} forwarding rule from the router.`);
    return;
  }

  await addMapping(endpoint, localIp);
  const externalIp = await getExternalIp(endpoint);
  console.log(`Forwarded TCP ${port} to ${localIp}:${port}.`);
  if (externalIp) {
    console.log(`Use this SaveSync relay URL from outside your network: ws://${externalIp}:${port}`);
  } else {
    console.log('Could not read public IP from router. Use the public IP shown in SaveSync or an IP lookup site.');
  }
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  console.error('Your router may have UPnP disabled/unsupported, or your ISP may use CGNAT. Use manual port forwarding or a VPS relay if this fails.');
  process.exit(1);
});
