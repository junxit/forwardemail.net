/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const ms = require('ms');

const config = require('#config');
const emailHelper = require('#helpers/email');
const i18n = require('#helpers/i18n');

async function sendPaginationCheck(ctx) {
  const key = `pagination_check:${ctx.state.user.id}`;
  try {
    const cache = await ctx.client.get(key);
    // return early if cache found
    if (cache) return;
    await ctx.client.set(key, true, 'PX', ms('90d'));
    const link = `${config.urls.web}/${ctx.locale}/api#pagination`;
    const subject = i18n.translate('PAGINATION_CHECK_SUBJECT', ctx.locale);
    const message = i18n.translate(
      'PAGINATION_CHECK_MESSAGE',
      ctx.locale,
      link,
      link
    );
    await emailHelper({
      template: 'alert',
      message: {
        to: ctx.state.user[config.userFields.fullEmail],
        bcc: config.email.message.from,
        subject
      },
      locals: {
        user: ctx.state.user.toObject(),
        message
      }
    });
  } catch (err) {
    ctx.logger.fatal(err);
    // if an error occurred while sending email then delete cache so it'll retry later
    ctx.client
      .del(key)
      .then()
      .catch((err) => ctx.logger.fatal(err));
  }
}

module.exports = sendPaginationCheck;