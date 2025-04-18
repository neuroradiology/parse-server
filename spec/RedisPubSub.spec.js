const RedisPubSub = require('../lib/Adapters/PubSub/RedisPubSub').RedisPubSub;

describe('RedisPubSub', function () {
  beforeEach(function (done) {
    // Mock redis
    const createClient = jasmine.createSpy('createClient').and.returnValue({
      connect: jasmine.createSpy('connect').and.resolveTo(),
      on: jasmine.createSpy('on'),
    });
    jasmine.mockLibrary('redis', 'createClient', createClient);
    done();
  });

  it('can create publisher', function () {
    RedisPubSub.createPublisher({
      redisURL: 'redisAddress',
      redisOptions: { socket_keepalive: true },
    });

    const redis = require('redis');
    expect(redis.createClient).toHaveBeenCalledWith({
      url: 'redisAddress',
      socket_keepalive: true,
      no_ready_check: true,
    });
  });

  it('can create subscriber', function () {
    RedisPubSub.createSubscriber({
      redisURL: 'redisAddress',
      redisOptions: { socket_keepalive: true },
    });

    const redis = require('redis');
    expect(redis.createClient).toHaveBeenCalledWith({
      url: 'redisAddress',
      socket_keepalive: true,
      no_ready_check: true,
    });
  });

  afterEach(function () {
    jasmine.restoreLibrary('redis', 'createClient');
  });
});
