/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const RE2 = require('re2');
const isSANB = require('is-string-and-not-blank');
const { fromUrl, parseDomain } = require('parse-domain');

const config = require('#config');
const env = require('#config/env');
const SMTPError = require('#helpers/smtp-error');
const checkSRS = require('#helpers/check-srs');
const getHeaders = require('#helpers/get-headers');
const logger = require('#helpers/logger');
const parseHostFromDomainOrAddress = require('#helpers/parse-host-from-domain-or-address');
const parseRootDomain = require('#helpers/parse-root-domain');

const REGEX_BLOCKED_PHRASES = new RE2(
  /recorded you|you've been hacked|account is hacked|personal data has leaked/im
);

// const REGEX_BITCOIN = new RE2(/bitcoin|btc/im);
// const REGEX_PASSWORD_MALWARE_INFECTED_VIDEO = new RE2(
//   /hacked|malware|infected|trojan|recorded you/im
// );

// TODO: remove yum here and wrap these with spaces or something
const REGEX_SYSADMIN_SUBJECT = new RE2(
  /weekly report|wordfence|wordpress|wpforms|docker|graylog|digest|event notification|package update manager|event alert|system events|monit alert|ping|monitor|cron|yum|sendmail|exim|backup|logwatch|unattended-upgrades/im
);

/*
const YAHOO_DOMAINS = new Set([
  'aim.com',
  'aol.com',
  'cox.net',
  'epix.net',
  'netscape.net',
  'rocketmail.com',
  'rogers.com',
  'sky.com'
  'verizon.net',
  'yahoo.ca',
  'yahoo.co.in',
  'yahoo.co.nz',
  'yahoo.co.uk',
  'yahoo.com',
  'yahoo.com.au',
  'yahoo.com.br',
  'yahoo.com.hk',
  'yahoo.com.mx',
  'yahoo.com.ph',
  'yahoo.de',
  'yahoo.dk',
  'yahoo.es',
  'yahoo.fr',
  'yahoo.gr',
  'yahoo.it',
  'ymail.com'
]);
*/

const REGEX_DOMAIN = new RE2(new RegExp(env.WEB_HOST, 'im'));

//
// this accounts for spammers that spoof our domain name in From
// but omit the ".com" portion, e.g. "ForwardEmail" or "forwardemail"
// (this will return just the domain portion, e.g. "forwardemail")
//
const result = parseDomain(fromUrl(env.WEB_HOST));
const domainWithoutTLD =
  result?.type === 'LISTED' && result?.domain ? result.domain : env.WEB_HOST;

const REGEX_DOMAIN_WITHOUT_TLD = new RE2(new RegExp(domainWithoutTLD, 'im'));
const REGEX_APP_NAME = new RE2(new RegExp(env.APP_NAME, 'im'));

// function isArbitrary(session, headers, bodyStr) {
// eslint-disable-next-line complexity
function isArbitrary(session, headers) {
  let subject = getHeaders(headers, 'subject');
  if (!isSANB(subject)) subject = null;

  // <https://github.com/andris9/mailsplit/issues/21>
  const from = getHeaders(headers, 'from');

  // rudimentary blocking
  if (subject && REGEX_BLOCKED_PHRASES.test(subject))
    throw new SMTPError(
      `Blocked phrase, please forward this to ${config.abuseEmail}`
    );

  //
  // check for paypal scam (very strict until PayPal resolves phishing on their side)
  // (seems to only come from "outlook.com" and "paypal.com" hosts)
  //
  // X-Email-Type-Id = RT000238
  //                   PPC001017
  //
  if (
    session.originalFromAddressRootDomain === 'paypal.com' &&
    headers.hasHeader('x-email-type-id') &&
    ['PPC001017', 'RT000238'].includes(headers.getFirst('x-email-type-id'))
  ) {
    const err = new SMTPError(
      'Due to ongoing PayPal invoice spam, you must manually send an invoice link'
    );
    err.isCodeBug = true; // alert admins for inspection
    throw err;
  }

  /*
  // NOTE: disabled due to false positives
  // check for btc crypto scam
  if (
    isSANB(bodyStr) &&
    REGEX_BITCOIN.test(bodyStr) &&
    REGEX_PASSWORD_MALWARE_INFECTED_VIDEO.test(bodyStr)
  )
    throw new SMTPError(
      `Blocked crypto scam, please forward this to ${config.abuseEmail}`
    );
  */

  //
  // NOTE: due to unprecendented spam from Microsoft's "onmicrosoft.com" domain
  //       we had to implement arbitrary rule to block spam from them
  //
  // <https://www.reddit.com/r/msp/comments/16n8p0j/spam_increase_from_onmicrosoftcom_addresses/>
  // <https://answers.microsoft.com/en-us/msoffice/forum/all/overwhelmed-by-onmicrosoftcom-spam-emails/6dcbd5c4-b661-47f5-95bc-1f3b412f398c>
  // <https://www.reddit.com/r/msp/comments/16n8p0j/comment/k1ns3ow/>
  //
  if (session.originalFromAddressRootDomain === 'onmicrosoft.com') {
    const msHeader = headers.getFirst('X-MS-Exchange-Authentication-Results');
    if (
      msHeader &&
      (msHeader.includes('spf=fail') ||
        msHeader.includes('spf=none') ||
        msHeader.includes('dmarc=fail') ||
        msHeader.includes('spf=softfail'))
    )
      throw new SMTPError(
        'Due to spam from onmicrosoft.com we have implemented restrictions; see https://old.reddit.com/r/msp/comments/16n8p0j/spam_increase_from_onmicrosoftcom_addresses/ ;'
      );
  }

  //
  // due to high amount of Microsoft spam we are blocking their bounces
  // if from postmaster@outlook.com and message is "Undeliverable: "
  //
  if (
    session.originalFromAddress === 'postmaster@outlook.com' &&
    subject &&
    subject.startsWith('Undeliverable: ')
  )
    throw new SMTPError(
      'Due to spam from onmicrosoft.com we have implemented restrictions; see https://old.reddit.com/r/msp/comments/16n8p0j/spam_increase_from_onmicrosoftcom_addresses/ ;'
    );

  //
  // due to high spam from 163.com we are blocking their bounces
  //
  if (
    session.originalFromAddress === 'postmaster@163.com' &&
    subject &&
    subject.includes('系统退信')
  )
    throw new SMTPError(
      'Due to spam from postmaster@163.com we have implemented bounce block restrictions'
    );

  //
  // due to microsoft and docusign scam
  //
  if (
    session.originalFromAddress === 'dse_na4@docusign.net' &&
    (session?.spf?.domain.endsWith('.onmicrosoft.com') ||
      session?.spf?.domain === 'onmicrosoft.com')
  )
    throw new SMTPError(
      'Due to spam from onmicrosoft.com and docusign.net SPF we have implemented restrictions; see https://old.sp/comments/16n8p0j/spam_increase_from_onmicrosoftcom_addresses/ ;'
    );

  //
  // this checks for messages that aren't coming from us
  // and contain a spoofed "From" address that looks like it's from us
  //
  if (
    (!session.hadAlignedAndPassingDKIM ||
      (session.hadAlignedAndPassingDKIM &&
        session.originalFromAddressRootDomain !== env.WEB_HOST)) &&
    (session.spfFromHeader.status.result !== 'pass' ||
      session.originalFromAddressRootDomain !== env.WEB_HOST) &&
    (REGEX_DOMAIN.test(from) ||
      REGEX_DOMAIN_WITHOUT_TLD.test(from) ||
      REGEX_APP_NAME.test(from))
  )
    throw new SMTPError(
      `Blocked spoofing, please forward this to ${config.abuseEmail}`
    );

  //
  // here is where we attempt to protect users from spammers
  // that impersonate spoofing the "From" address in an email
  // as if it's from their domain name, which is a common attack
  //
  // note that we only check this if DKIM wasn't aligned and passing
  // and if the sender's hostname is not same as From header's hostname
  // so we use `session.hasSameHostnameAsFrom` for this (which is set in `helpers/update-session.js`)
  // because that's an obvious signal that it's coming from the same address
  // due to the resolved client hostname of the reverse lookup on the `session.remoteAddress`
  //
  // the way that we check this is quite simple:
  // all we need to do is check if any of the RCPT TO values have a matching root domain as From header
  // AND if the From header was not SPF aligned, then throw the error
  //
  // NOTE: we do have one exception to this, and it is that often
  //       system administrators will set up cron jobs to send them alerts
  //       (which often are sent to the same domain name) and are lacking passing SPF
  //       (or the administrator simply never configured an SPF policy)
  //       therefore we check for those cases with a simple regular expression against the Subject line
  //       and if the SPF policy was not strictly failing, then it's probably a legitimate message
  //
  if (
    !session.hasSameHostnameAsFrom &&
    !session.hadAlignedAndPassingDKIM &&
    !session.isAllowlisted
  ) {
    const hasSameRcptToAsFrom = session.envelope.rcptTo.some(
      (to) =>
        parseRootDomain(parseHostFromDomainOrAddress(checkSRS(to.address))) ===
        session.originalFromAddressRootDomain
    );
    if (hasSameRcptToAsFrom && session.spfFromHeader.status.result !== 'pass')
      session.isPotentialPhishing = true; // used after email is delivered to imap/webhook/forwarding to send a one-time email
    if (
      hasSameRcptToAsFrom &&
      session.spfFromHeader.status.result !== 'pass' &&
      // NOTE: a lot of sysadmins have improperly configured SPF/DKIM
      //       on their servers and send wordpress/php script alerts
      !headers.hasHeader('x-php-script') &&
      !(
        headers.hasHeader('x-mailer') &&
        // PHP/PHPMailer/Drupal
        ['php', 'drupal'].includes(headers.getFirst('x-mailer').toLowerCase())
      ) &&
      !(subject && REGEX_SYSADMIN_SUBJECT.test(subject))
    ) {
      // TODO: until we're certain this is properly working we're going to monitor it with code bug to admins
      const err = new TypeError(
        `Spoofing detected and was soft blocked from ${
          session.resolvedRootClientHostname || session.remoteAddress
        }`
      );
      err.isCodeBug = true;
      err.session = session;
      logger.fatal(err);

      throw new SMTPError(
        'Message likely to be spoofing attack and was rejected due to lack of SPF alignment with From header',
        { responseCode: 421 }
      );
    }
  }

  //
  // NOTE: we may want to handle Reply-To attack where the reply address is different than the From address
  //       BUT... this is typically handled with the logic above
  //       (for example, someone sends an email "We have your password, send us BTC")
  //       (and the From is you@yourdomain.com and the To is you@yourdomain.com, but the Reply-To needs to be different)
  //       (otherwise the spammer/attacker would never get the response to the email)
  //
}

module.exports = isArbitrary;
