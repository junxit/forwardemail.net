/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const punycode = require('node:punycode');
const { isIP } = require('node:net');

const URLParse = require('url-parse');
const isFQDN = require('is-fqdn');
const { isURL } = require('@forwardemail/validator');

const SMTPError = require('#helpers/smtp-error');
const parseAddresses = require('#helpers/parse-addresses');

function parseHostFromDomainOrAddress(address) {
  let domain = address;

  if (
    isURL(address, { require_protocol: true, protocols: ['http', 'https'] })
  ) {
    const url = new URLParse(address);
    domain = url.hostname;
  } else {
    const parsedAddresses = parseAddresses(address);
    if (parsedAddresses[0]) domain = parsedAddresses[0];
  }

  const atPos = domain.indexOf('@');
  if (atPos !== -1) domain = domain.slice(atPos + 1);

  domain = domain.toLowerCase().trim();

  try {
    domain = punycode.toASCII(domain);
  } catch {
    // ignore punycode conversion errors
  }

  //
  // if it starts with [ and ends with ] and value inside is IP then use that
  // (this is nodemailer supported IP address syntax to send email to an IP)
  //
  if (
    domain &&
    domain.startsWith('[') &&
    domain.endsWith(']') &&
    isIP(domain.slice(1, -1))
  )
    domain = domain.slice(1, -1);

  // ensure fully qualified domain name or IP address
  if (!domain || (!isFQDN(domain) && !isIP(domain)))
    throw new SMTPError(
      `${
        domain || address
      } does not contain a fully qualified domain name ("FQDN") nor IP address`,
      { responseCode: 550 }
    );

  return domain;
}

module.exports = parseHostFromDomainOrAddress;
