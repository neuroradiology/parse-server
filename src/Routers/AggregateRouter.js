import Parse from 'parse/node';
import * as middleware from '../middlewares';
import rest from '../rest';
import ClassesRouter from './ClassesRouter';
import UsersRouter from './UsersRouter';

export class AggregateRouter extends ClassesRouter {
  async handleFind(req) {
    const body = Object.assign(req.body || {}, ClassesRouter.JSONFromQuery(req.query));
    const options = {};
    if (body.distinct) {
      options.distinct = String(body.distinct);
    }
    if (body.hint) {
      options.hint = body.hint;
      delete body.hint;
    }
    if (body.explain) {
      options.explain = body.explain;
      delete body.explain;
    }
    if (body.comment) {
      options.comment = body.comment;
      delete body.comment;
    }
    if (body.readPreference) {
      options.readPreference = body.readPreference;
      delete body.readPreference;
    }
    options.pipeline = AggregateRouter.getPipeline(body);
    if (typeof body.where === 'string') {
      body.where = JSON.parse(body.where);
    }
    try {
      const response = await rest.find(
        req.config,
        req.auth,
        this.className(req),
        body.where,
        options,
        req.info.clientSDK,
        req.info.context
      );
      for (const result of response.results) {
        if (typeof result === 'object') {
          UsersRouter.removeHiddenProperties(result);
        }
      }
      return { response };
    } catch (e) {
      throw new Parse.Error(Parse.Error.INVALID_QUERY, e.message);
    }
  }

  /* Builds a pipeline from the body. Originally the body could be passed as a single object,
   * and now we support many options.
   *
   * Array
   *
   * body: [{
   *   group: { objectId: '$name' },
   * }]
   *
   * Object
   *
   * body: {
   *   group: { objectId: '$name' },
   * }
   *
   *
   * Pipeline Operator with an Array or an Object
   *
   * body: {
   *   pipeline: {
   *     $group: { objectId: '$name' },
   *   }
   * }
   *
   */
  static getPipeline(body) {
    let pipeline = body.pipeline || body;
    if (!Array.isArray(pipeline)) {
      pipeline = Object.keys(pipeline)
        .filter(key => pipeline[key] !== undefined)
        .map(key => {
          return { [key]: pipeline[key] };
        });
    }

    return pipeline.map(stage => {
      const keys = Object.keys(stage);
      if (keys.length !== 1) {
        throw new Parse.Error(
          Parse.Error.INVALID_QUERY,
          `Pipeline stages should only have one key but found ${keys.join(', ')}.`
        );
      }
      return AggregateRouter.transformStage(keys[0], stage);
    });
  }

  static transformStage(stageName, stage) {
    const skipKeys = ['distinct', 'where'];
    if (skipKeys.includes(stageName)) {
      return;
    }
    if (stageName[0] !== '$') {
      throw new Parse.Error(Parse.Error.INVALID_QUERY, `Invalid aggregate stage '${stageName}'.`);
    }
    if (stageName === '$group') {
      if (Object.prototype.hasOwnProperty.call(stage[stageName], 'objectId')) {
        throw new Parse.Error(
          Parse.Error.INVALID_QUERY,
          `Cannot use 'objectId' in aggregation stage $group.`
        );
      }
      if (!Object.prototype.hasOwnProperty.call(stage[stageName], '_id')) {
        throw new Parse.Error(
          Parse.Error.INVALID_QUERY,
          `Invalid parameter for query: group. Missing key _id`
        );
      }
    }
    return { [stageName]: stage[stageName] };
  }

  mountRoutes() {
    this.route('GET', '/aggregate/:className', middleware.promiseEnforceMasterKeyAccess, req => {
      return this.handleFind(req);
    });
  }
}

export default AggregateRouter;
