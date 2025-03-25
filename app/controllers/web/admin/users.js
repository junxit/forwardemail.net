/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const Boom = require('@hapi/boom');
const _ = require('lodash');
const isSANB = require('is-string-and-not-blank');
const paginate = require('koa-ctx-paginate');
const parser = require('mongodb-query-parser');
const { boolean } = require('boolean');

const { Users } = require('#models');
const config = require('#config');

const USER_SEARCH_PATHS = [
  'email',
  config.passport.fields.givenName,
  config.passport.fields.familyName
];

async function list(ctx) {
  let query = {};

  if (ctx.query.q) {
    query = { $or: [] };

    for (const field of USER_SEARCH_PATHS) {
      query.$or.push(
        { [field]: { $regex: ctx.query.q, $options: 'i' } },
        { [field]: { $regex: _.escapeRegExp(ctx.query.q), $options: 'i' } }
      );
    }

    // filter for non-banned and verified users
    query[config.userFields.isBanned] = false;
    query[config.userFields.hasVerifiedEmail] = true;
  }

  if (isSANB(ctx.query.mongodb_query)) {
    try {
      query = parser.parseFilter(ctx.query.mongodb_query);
      if (!query || Object.keys(query).length === 0)
        throw new Error('Query was not parsed propery');
    } catch (err) {
      ctx.logger.warn(err);
      throw Boom.badRequest(err.message);
    }
  }

  const [users, itemCount] = await Promise.all([
    // eslint-disable-next-line unicorn/no-array-callback-reference
    Users.find(query)
      .limit(ctx.query.limit)
      .skip(ctx.paginate.skip)
      .lean()
      .sort(ctx.query.sort || '-created_at')
      .exec(),
    Users.countDocuments(query)
  ]);

  const pageCount = Math.ceil(itemCount / ctx.query.limit);

  if (ctx.accepts('html'))
    return ctx.render('admin/users', {
      users,
      pageCount,
      itemCount,
      pages: paginate.getArrayPages(ctx)(6, pageCount, ctx.query.page)
    });

  const table = await ctx.render('admin/users/_table', {
    users,
    pageCount,
    itemCount,
    pages: paginate.getArrayPages(ctx)(6, pageCount, ctx.query.page)
  });

  ctx.body = { table };
}

async function retrieve(ctx) {
  ctx.state.result = await Users.findById(ctx.params.id);
  if (!ctx.state.result)
    throw Boom.notFound(ctx.translateError('INVALID_USER'));
  return ctx.render('admin/users/retrieve');
}

async function update(ctx) {
  const user = await Users.findById(ctx.params.id);
  if (!user) throw Boom.notFound(ctx.translateError('INVALID_USER'));
  const { body } = ctx.request;

  user[config.passport.fields.givenName] =
    body[config.passport.fields.givenName];
  user[config.passport.fields.familyName] =
    body[config.passport.fields.familyName];
  user[config.passport.fields.otpEnabled] =
    body[config.passport.fields.otpEnabled];
  user.email = body.email;
  user.group = body.group;

  if (boolean(!body[config.passport.fields.otpEnabled]))
    user[config.userFields.pendingRecovery] = false;

  await user.save();

  if (user.id === ctx.state.user.id) await ctx.login(user);

  ctx.flash('custom', {
    title: ctx.request.t('Success'),
    text: ctx.translate('REQUEST_OK'),
    type: 'success',
    toast: true,
    showConfirmButton: false,
    timer: 3000,
    position: 'top'
  });

  if (ctx.accepts('html')) ctx.redirect('back');
  else ctx.body = { reloadPage: true };
}

async function remove(ctx) {
  const user = await Users.findById(ctx.params.id);
  if (!user) throw Boom.notFound(ctx.translateError('INVALID_USER'));
  // instead of removing the user entirely we just ban them
  user[config.userFields.isBanned] = true;
  await user.save();
  // clear banned cache
  ctx.client
    .del('banned_user_ids')
    .then()
    .catch((err) => ctx.logger.fatal(err));
  ctx.flash('custom', {
    title: ctx.request.t('Success'),
    text: ctx.translate('REQUEST_OK'),
    type: 'success',
    toast: true,
    showConfirmButton: false,
    timer: 3000,
    position: 'top'
  });

  if (ctx.accepts('html')) ctx.redirect('back');
  else ctx.body = { reloadPage: true };
}

async function login(ctx) {
  const user = await Users.findById(ctx.params.id);
  if (!user) throw Boom.notFound(ctx.translateError('INVALID_USER'));

  // store a reference to the session ID so we can clean it up on user model
  const { sessionId } = ctx;
  const userId = ctx.state.user._id;

  ctx.logout();

  await ctx.login(user);

  // remove from the user session array the matching value
  // (from the admin's session list)
  Users.findByIdAndUpdate(userId, {
    $pullAll: {
      sessions: [sessionId]
    }
  })
    .then()
    .catch((err) => ctx.logger.fatal(err));

  if (user[config.passport.fields.otpEnabled] && ctx.session) {
    ctx.session.otp_remember_me = false;
    ctx.session.otp = 'totp';
  }

  ctx.flash('custom', {
    title: ctx.request.t('Success'),
    text: ctx.translate('REQUEST_OK'),
    type: 'success',
    toast: true,
    showConfirmButton: false,
    timer: 3000,
    position: 'top'
  });

  if (ctx.accepts('html')) ctx.redirect('/');
  else ctx.body = { redirectTo: '/' };
}

module.exports = { list, retrieve, update, remove, login };
