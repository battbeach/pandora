import {Location, Selector, MessagePackage, ReplyPackage, PublishPackage, LookupPackage, ForceReplyFn} from '../domain';
import {MessengerClient} from 'pandora-messenger';
import {
  HUB_SOCKET_NAME, PANDORA_HUB_ACTION_DISCOVER_UP, PANDORA_HUB_ACTION_MSG_UP, PANDORA_HUB_ACTION_PUBLISH_UP,
  PANDORA_HUB_ACTION_UNPUBLISH_UP, PANDORA_HUB_ACTION_MSG_DOWN, PANDORA_HUB_ACTION_ONLINE_UP,
  PANDORA_HUB_ACTION_OFFLINE_UP, TIMEOUT_OF_RESPONSE
} from '../const';
import {SelectorUtils} from '../SelectorUtils';
import {format} from 'util';

export interface ClientOptions {
  location: Location;
  logger?: any;
}

export class Client {

  protected location: Location;
  protected messengerClient: MessengerClient = null;
  protected publishedSelectors: Array<Selector> = [];
  protected logger;

  constructor (options: ClientOptions) {
    this.location = options.location;
    this.logger = options.logger || console;
  }

  async handleHubDispatch(message: MessagePackage): Promise<any> {
    return {
      echo: message
    };
  }

  /**
   * Let this client online
   * @return {Promise<void>}
   */
  async start() {

    if(this.messengerClient) {
      throw new Error('A messengerClient already exist');
    }

    this.messengerClient = new MessengerClient({
      name: HUB_SOCKET_NAME,
      reConnectTimes: 100,
      responseTimeout: TIMEOUT_OF_RESPONSE
    });

    this.messengerClient.on(PANDORA_HUB_ACTION_MSG_DOWN, async (message: MessagePackage, reply: ForceReplyFn) => {
      try {
        let replyPkg: ReplyPackage = null;
        try {
          const data = await this.handleHubDispatch(message);
          replyPkg = {
            success: true,
            data: data
          };
        } catch (error) {
          replyPkg = {
            success: false,
            error: error
          };
        }
        if(message.needReply) {
          reply(replyPkg);
        }
      } catch (err) {
        this.logger.error('handing PANDORA_HUB_ACTION_MSG_DOWN went wrong, remote message: %j', message);
        this.logger.error(err);
      }
    });

    await new Promise(resolve => {
      this.messengerClient.ready(resolve);
    });

    await this.sendOnline();

    // When reconnected
    this.messengerClient.on('connect', () => {
      this.resendPublishedSelectors().catch((err) => {
        this.logger.error(err);
        this.logger.error('resendPublishedSelectors() went wrong');
      });
    });

  }

  protected async sendOnline () {
    await this.sendToHubAndWaitReply(PANDORA_HUB_ACTION_ONLINE_UP);
  }

  /**
   * Publish a selector to Hub, so Hub will set a relation in RouteTable between client and selector
   * @param {Selector} selector
   * @return {Promise<ReplyPackage>}
   */
  async publish(selector: Selector): Promise<ReplyPackage> {
    // Make sure each selector are unique.
    this.assertExistSelector(selector);
    const res = await this.sendPublishToHub(selector);
    this.publishedSelectors.push(selector);
    return res;
  }

  /**
   * Unpublish a selector to Hub, so Hub will forget the relation in RouteTable between client and selector
   * @param {Selector} selector
   * @return {Promise<ReplyPackage>}
   */
  async unpublish(selector: Selector): Promise<ReplyPackage> {
    const filteredSelectors: Array<Selector> = [];
    const batchReply = [];
    for(const targetSelector of this.publishedSelectors) {
      if(!SelectorUtils.match(selector, targetSelector)) {
        filteredSelectors.push(targetSelector);
        continue;
      }
      const res = await this.sendToHubAndWaitReply<PublishPackage>(PANDORA_HUB_ACTION_UNPUBLISH_UP, {
        data: {
          selector: targetSelector
        }
      });
      batchReply.push(res);
      if(!res.success) {
        throw new Error(format('unpublish selector %j went wrong, cause from Hub: %j', selector, res.error));
      }
    }
    this.publishedSelectors = filteredSelectors;
    return {
      success: true,
      batchReply
    };
  }

  /**
   * Resend all published selectors to HUB when reconnected
   * @return {Promise<void>}
   */
  protected async resendPublishedSelectors () {
    await this.sendOnline();
    for(const selector of this.publishedSelectors) {
      await this.publish(selector);
    }
  }

  /**
   * Get all route relations within Hub
   * @return {Promise<any>}
   */
  async discover() {
    const res = await this.sendToHubAndWaitReply(PANDORA_HUB_ACTION_DISCOVER_UP);
    if(!res.success) {
      throw new Error(format('discover whole hub went wrong, cause from Hub: %j', res.error));
    }
    return res.data;
  }

  /**
   * Lookup route relations by a certain selector
   * @param {Selector} selector
   * @return {Promise<any>}
   */
  async lookup(selector: Selector) {
    const res = await this.sendToHubAndWaitReply<LookupPackage>(PANDORA_HUB_ACTION_DISCOVER_UP, {
      data: {
        selector: selector
      }
    });
    if(!res.success) {
      throw new Error(format('lookup selector %j went wrong, cause from Hub: %j', selector, res.error));
    }
    return res.data;
  }

  /**
   * Invoke a remote Service only from a random one of all selected clients
   * @return {Promise<any>}
   */
  async invoke(remote: Selector, data): Promise<ReplyPackage> {
    const res = await this.sendToHubAndWaitReply(PANDORA_HUB_ACTION_MSG_UP, {
      remote: remote,
      broadcast: false,
      data: data
    });
    return res;
  }

  /**
   * Invoke a remote Service from all selected clients
   * @param {Selector} remote
   * @param data
   * @return {Promise<Array<ReplyPackage>>}
   */
  async multipleInvoke(remote: Selector, data): Promise<Array<ReplyPackage>> {
    const res = await this.sendToHubAndWaitReply(PANDORA_HUB_ACTION_MSG_UP, {
      remote: remote,
      broadcast: true,
      data: data
    });
    return res.batchReply;
  }

  /**
   * Send a message to a random one of all selected clients
   * @param remote
   * @param data
   * @return {Promise<void>}
   */
  send(remote: Selector, data): void {
    this.sendToHub(PANDORA_HUB_ACTION_MSG_UP, {
      remote: remote,
      broadcast: false,
      data: data
    });
  }

  /**
   * Send a message to all selected clients
   * @param remote
   * @param data
   * @return {Promise<void>}
   */
  multipleSend(remote: Selector, data): void {
    this.sendToHub(PANDORA_HUB_ACTION_MSG_UP, {
      remote: remote,
      broadcast: true,
      data: data
    });
  }

  /**
   * Get location of this client
   * @return {Location}
   */
  getLocation () {
    return this.location;
  }

  /**
   * Send a message to Hub
   */
  protected sendToHub<MessageType extends MessagePackage>(action, message?: MessageType): void {
    message = <any> (message || {});
    message.host = this.location;
    this.messengerClient.send(action, message);
  }

  /**
   * Send a message to Hub and wait reply
   * @param action
   * @param {MessageType} message
   * @return {Promise<ReplyPackage>}
   */
  protected async sendToHubAndWaitReply<MessageType extends MessagePackage>(action, message?: MessageType): Promise<ReplyPackage> {
    message = <any> (message || {});
    message.host = this.location;
    message.needReply = true;
    return new Promise(((resolve, reject) => {
      this.messengerClient.send(action, message, (err, message: ReplyPackage) => {
        if(err) {
          reject(err);
          return;
        }
        resolve(message);
      });
    }));
  }

  /**
   * only send publish message to Hub without state keeping
   * @param {Selector} selector
   * @return {Promise<ReplyPackage>}
   */
  protected async sendPublishToHub(selector: Selector): Promise<ReplyPackage> {
    const res = await this.sendToHubAndWaitReply<PublishPackage>(PANDORA_HUB_ACTION_PUBLISH_UP, {
      data: {
        selector: selector
      }
    });
    if(!res.success) {
      throw new Error(format('publish selector %j went wrong, cause from Hub: %j', selector, res.error));
    }
    return res;
  }

  /**
   * Make sure each selector are unique
   * @param selector
   */
  protected assertExistSelector (selector) {
    for(const targetSelector of this.publishedSelectors) {
      if(SelectorUtils.match(selector, targetSelector)) {
        throw new Error(format('Selector %j already exist', selector));
      }
    }
  }

  /**
   * Close this client
   */
  async stop() {
    await this.sendToHubAndWaitReply(PANDORA_HUB_ACTION_OFFLINE_UP);
    this.messengerClient.close();
    this.messengerClient = null;
  }

}