import { randomString } from '../cryptoUtils';
import { inflate } from '../triggers';
import AdaptableController from './AdaptableController';
import MailAdapter from '../Adapters/Email/MailAdapter';
import rest from '../rest';
import Parse from 'parse/node';
import AccountLockout from '../AccountLockout';
import Config from '../Config';

var RestQuery = require('../RestQuery');
var Auth = require('../Auth');

export class UserController extends AdaptableController {
  constructor(adapter, appId, options = {}) {
    super(adapter, appId, options);
  }

  get config() {
    return Config.get(this.appId);
  }

  validateAdapter(adapter) {
    // Allow no adapter
    if (!adapter && !this.shouldVerifyEmails) {
      return;
    }
    super.validateAdapter(adapter);
  }

  expectedAdapterType() {
    return MailAdapter;
  }

  get shouldVerifyEmails() {
    return (this.config || this.options).verifyUserEmails;
  }

  async setEmailVerifyToken(user, req, storage = {}) {
    const shouldSendEmail =
      this.shouldVerifyEmails === true ||
      (typeof this.shouldVerifyEmails === 'function' &&
        (await Promise.resolve(this.shouldVerifyEmails(req))) === true);
    if (!shouldSendEmail) {
      return false;
    }
    storage.sendVerificationEmail = true;
    user._email_verify_token = randomString(25);
    if (
      !storage.fieldsChangedByTrigger ||
      !storage.fieldsChangedByTrigger.includes('emailVerified')
    ) {
      user.emailVerified = false;
    }

    if (this.config.emailVerifyTokenValidityDuration) {
      user._email_verify_token_expires_at = Parse._encode(
        this.config.generateEmailVerifyTokenExpiresAt()
      );
    }
    return true;
  }

  async verifyEmail(token) {
    if (!this.shouldVerifyEmails) {
      // Trying to verify email when not enabled
      // TODO: Better error here.
      throw undefined;
    }

    const query = { _email_verify_token: token };
    const updateFields = {
      emailVerified: true,
      _email_verify_token: { __op: 'Delete' },
    };

    // if the email verify token needs to be validated then
    // add additional query params and additional fields that need to be updated
    if (this.config.emailVerifyTokenValidityDuration) {
      query.emailVerified = false;
      query._email_verify_token_expires_at = { $gt: Parse._encode(new Date()) };

      updateFields._email_verify_token_expires_at = { __op: 'Delete' };
    }
    const maintenanceAuth = Auth.maintenance(this.config);
    const restQuery = await RestQuery({
      method: RestQuery.Method.get,
      config: this.config,
      auth: maintenanceAuth,
      className: '_User',
      restWhere: query,
    });

    const result = await restQuery.execute();
    if (result.results.length) {
      query.objectId = result.results[0].objectId;
    }
    return await rest.update(this.config, maintenanceAuth, '_User', query, updateFields);
  }

  async checkResetTokenValidity(token) {
    const results = await this.config.database.find(
      '_User',
      {
        _perishable_token: token,
      },
      { limit: 1 },
      Auth.maintenance(this.config)
    );
    if (results.length !== 1) {
      throw 'Failed to reset password: username / email / token is invalid';
    }

    if (this.config.passwordPolicy && this.config.passwordPolicy.resetTokenValidityDuration) {
      let expiresDate = results[0]._perishable_token_expires_at;
      if (expiresDate && expiresDate.__type == 'Date') {
        expiresDate = new Date(expiresDate.iso);
      }
      if (expiresDate < new Date()) {
        throw 'The password reset link has expired';
      }
    }

    return results[0];
  }

  async getUserIfNeeded(user) {
    var where = {};
    if (user.username) {
      where.username = user.username;
    }
    if (user.email) {
      where.email = user.email;
    }
    if (user._email_verify_token) {
      where._email_verify_token = user._email_verify_token;
    }

    var query = await RestQuery({
      method: RestQuery.Method.get,
      config: this.config,
      runBeforeFind: false,
      auth: Auth.master(this.config),
      className: '_User',
      restWhere: where,
    });
    const result = await query.execute();
    if (result.results.length != 1) {
      throw undefined;
    }
    return result.results[0];
  }

  async sendVerificationEmail(user, req) {
    if (!this.shouldVerifyEmails) {
      return;
    }
    const token = encodeURIComponent(user._email_verify_token);
    // We may need to fetch the user in case of update email; only use the `fetchedUser`
    // from this point onwards; do not use the `user` as it may not contain all fields.
    const fetchedUser = await this.getUserIfNeeded(user);
    let shouldSendEmail = this.config.sendUserEmailVerification;
    if (typeof shouldSendEmail === 'function') {
      const response = await Promise.resolve(
        this.config.sendUserEmailVerification({
          user: Parse.Object.fromJSON({ className: '_User', ...fetchedUser }),
          master: req.auth?.isMaster,
        })
      );
      shouldSendEmail = !!response;
    }
    if (!shouldSendEmail) {
      return;
    }
    const link = buildEmailLink(this.config.verifyEmailURL, token, this.config);
    const options = {
      appName: this.config.appName,
      link: link,
      user: inflate('_User', fetchedUser),
    };
    if (this.adapter.sendVerificationEmail) {
      this.adapter.sendVerificationEmail(options);
    } else {
      this.adapter.sendMail(this.defaultVerificationEmail(options));
    }
  }

  /**
   * Regenerates the given user's email verification token
   *
   * @param user
   * @returns {*}
   */
  async regenerateEmailVerifyToken(user, master, installationId, ip) {
    const { _email_verify_token } = user;
    let { _email_verify_token_expires_at } = user;
    if (_email_verify_token_expires_at && _email_verify_token_expires_at.__type === 'Date') {
      _email_verify_token_expires_at = _email_verify_token_expires_at.iso;
    }
    if (
      this.config.emailVerifyTokenReuseIfValid &&
      this.config.emailVerifyTokenValidityDuration &&
      _email_verify_token &&
      new Date() < new Date(_email_verify_token_expires_at)
    ) {
      return Promise.resolve(true);
    }
    const shouldSend = await this.setEmailVerifyToken(user, {
      object: Parse.User.fromJSON(Object.assign({ className: '_User' }, user)),
      master,
      installationId,
      ip,
      resendRequest: true
    });
    if (!shouldSend) {
      return;
    }
    return this.config.database.update('_User', { username: user.username }, user);
  }

  async resendVerificationEmail(username, req, token) {
    const aUser = await this.getUserIfNeeded({ username, _email_verify_token: token });
    if (!aUser || aUser.emailVerified) {
      throw undefined;
    }
    const generate = await this.regenerateEmailVerifyToken(aUser, req.auth?.isMaster, req.auth?.installationId, req.ip);
    if (generate) {
      this.sendVerificationEmail(aUser, req);
    }
  }

  setPasswordResetToken(email) {
    const token = { _perishable_token: randomString(25) };

    if (this.config.passwordPolicy && this.config.passwordPolicy.resetTokenValidityDuration) {
      token._perishable_token_expires_at = Parse._encode(
        this.config.generatePasswordResetTokenExpiresAt()
      );
    }

    return this.config.database.update(
      '_User',
      { $or: [{ email }, { username: email, email: { $exists: false } }] },
      token,
      {},
      true
    );
  }

  async sendPasswordResetEmail(email) {
    if (!this.adapter) {
      throw 'Trying to send a reset password but no adapter is set';
      //  TODO: No adapter?
    }
    let user;
    if (
      this.config.passwordPolicy &&
      this.config.passwordPolicy.resetTokenReuseIfValid &&
      this.config.passwordPolicy.resetTokenValidityDuration
    ) {
      const results = await this.config.database.find(
        '_User',
        {
          $or: [
            { email, _perishable_token: { $exists: true } },
            { username: email, email: { $exists: false }, _perishable_token: { $exists: true } },
          ],
        },
        { limit: 1 },
        Auth.maintenance(this.config)
      );
      if (results.length == 1) {
        let expiresDate = results[0]._perishable_token_expires_at;
        if (expiresDate && expiresDate.__type == 'Date') {
          expiresDate = new Date(expiresDate.iso);
        }
        if (expiresDate > new Date()) {
          user = results[0];
        }
      }
    }
    if (!user || !user._perishable_token) {
      user = await this.setPasswordResetToken(email);
    }
    const token = encodeURIComponent(user._perishable_token);
    const link = buildEmailLink(this.config.requestResetPasswordURL, token, this.config);
    const options = {
      appName: this.config.appName,
      link: link,
      user: inflate('_User', user),
    };

    if (this.adapter.sendPasswordResetEmail) {
      this.adapter.sendPasswordResetEmail(options);
    } else {
      this.adapter.sendMail(this.defaultResetPasswordEmail(options));
    }

    return Promise.resolve(user);
  }

  async updatePassword(token, password) {
    try {
      const rawUser = await this.checkResetTokenValidity(token);
      const user = await updateUserPassword(rawUser, password, this.config);

      const accountLockoutPolicy = new AccountLockout(user, this.config);
      return await accountLockoutPolicy.unlockAccount();
    } catch (error) {
      if (error && error.message) {
        // in case of Parse.Error, fail with the error message only
        return Promise.reject(error.message);
      }
      return Promise.reject(error);
    }
  }

  defaultVerificationEmail({ link, user, appName }) {
    const text =
      'Hi,\n\n' +
      'You are being asked to confirm the e-mail address ' +
      user.get('email') +
      ' with ' +
      appName +
      '\n\n' +
      '' +
      'Click here to confirm it:\n' +
      link;
    const to = user.get('email');
    const subject = 'Please verify your e-mail for ' + appName;
    return { text, to, subject };
  }

  defaultResetPasswordEmail({ link, user, appName }) {
    const text =
      'Hi,\n\n' +
      'You requested to reset your password for ' +
      appName +
      (user.get('username') ? " (your username is '" + user.get('username') + "')" : '') +
      '.\n\n' +
      '' +
      'Click here to reset it:\n' +
      link;
    const to = user.get('email') || user.get('username');
    const subject = 'Password Reset for ' + appName;
    return { text, to, subject };
  }
}

// Mark this private
function updateUserPassword(user, password, config) {
  return rest
    .update(
      config,
      Auth.master(config),
      '_User',
      { objectId: user.objectId },
      {
        password: password,
      }
    )
    .then(() => user);
}

function buildEmailLink(destination, token, config) {
  token = `token=${token}`;
  if (config.parseFrameURL) {
    const destinationWithoutHost = destination.replace(config.publicServerURL, '');

    return `${config.parseFrameURL}?link=${encodeURIComponent(destinationWithoutHost)}&${token}`;
  } else {
    return `${destination}?${token}`;
  }
}

export default UserController;
