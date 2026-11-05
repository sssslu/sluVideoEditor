import net, {type Server, type Socket} from 'node:net';

/** A private loopback stream with bounded Node/OS backpressure. The FFmpeg
 * encoder reads consumerUrl; render workers connect to producerUrl. No raw
 * frame intermediates are written to disk. */
export class RawStreamBridge {
  private consumerServer?:Server;
  private producerServer?:Server;
  private consumer?:Socket;
  private producers=new Set<Socket>();
  private consumerReady:Promise<Socket>;
  private resolveConsumer!:(socket:Socket)=>void;
  private rejectConsumer!:(error:Error)=>void;
  private expected?:{bytes:number;resolve:()=>void;reject:(error:Error)=>void};
  private failure?:Error;
  private ended=false;
  private detachAbort?:()=>void;
  consumerUrl='';producerUrl='';
  totalBytes=0;peakBufferedBytes=0;
  constructor(private onFailure:(error:Error)=>void){
    this.consumerReady=new Promise((resolve,reject)=>{this.resolveConsumer=resolve;this.rejectConsumer=reject;});
    // A failed encoder may never connect. Keep the rejection handled until a
    // writer awaits it, while forwarding the actual failure through onFailure.
    void this.consumerReady.catch(()=>{});
  }
  async open(signal?:AbortSignal){
    const listen=async(handler:(socket:Socket)=>void)=>{
      const server=net.createServer(handler);server.on('error',error=>this.fail(error));
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
      const address=server.address();if(!address||typeof address==='string')throw new Error('로컬 영상 스트림을 만들 수 없습니다.');
      return {server,url:`tcp://127.0.0.1:${address.port}`};
    };
    const consumer=await listen(socket=>{
      if(this.consumer||this.ended){socket.destroy();return;}
      this.consumer=socket;socket.setNoDelay(true);socket.on('error',error=>this.fail(error));
      socket.on('close',()=>{if(!this.ended)this.fail(new Error('인코더가 영상 스트림 연결을 종료했습니다.'));});
      this.resolveConsumer(socket);
    });
    this.consumerServer=consumer.server;this.consumerUrl=consumer.url;
    const producer=await listen(socket=>{void this.acceptProducer(socket);});this.producerServer=producer.server;this.producerUrl=producer.url;
    if(signal){const abort=()=>this.close(Object.assign(new Error('작업을 취소했습니다.'),{name:'AbortError'}));signal.addEventListener('abort',abort,{once:true});this.detachAbort=()=>signal.removeEventListener('abort',abort);if(signal.aborted)abort();}
    return this;
  }
  private fail(error:Error){if(this.failure||this.ended)return;this.failure=error;this.rejectConsumer(error);this.expected?.reject(error);this.expected=undefined;this.onFailure(error);}
  async write(buffer:Buffer){
    if(this.failure)throw this.failure;if(this.ended)throw new Error('영상 스트림이 이미 닫혔습니다.');
    const socket=await this.consumerReady;if(this.failure)throw this.failure;
    this.peakBufferedBytes=Math.max(this.peakBufferedBytes,socket.writableLength+buffer.length);
    await new Promise<void>((resolve,reject)=>socket.write(buffer,error=>error?reject(error):resolve()));this.totalBytes+=buffer.length;
  }
  expectProducer(bytes:number):Promise<void>{
    if(this.expected)throw new Error('이전 렌더 구간이 아직 완료되지 않았습니다.');
    if(this.failure)return Promise.reject(this.failure);
    return new Promise((resolve,reject)=>{this.expected={bytes,resolve,reject};});
  }
  private async acceptProducer(socket:Socket){
    const expected=this.expected;if(!expected||this.producers.size){socket.destroy();this.fail(new Error('예상하지 않은 렌더 스트림 연결입니다.'));return;}
    this.producers.add(socket);socket.setNoDelay(true);let bytes=0;
    try{
      for await(const chunk of socket){const buffer=chunk as Buffer;bytes+=buffer.length;if(bytes>expected.bytes)throw new Error('렌더 구간의 프레임 수가 예상보다 많습니다.');await this.write(buffer);}
      if(bytes!==expected.bytes)throw new Error(`렌더 구간이 불완전합니다 (${bytes}/${expected.bytes} 바이트).`);
      this.expected=undefined;expected.resolve();
    }catch(error){expected.reject(error instanceof Error?error:new Error(String(error)));this.fail(error instanceof Error?error:new Error(String(error)));}
    finally{this.producers.delete(socket);socket.destroy();}
  }
  async end(){
    if(this.failure)throw this.failure;const socket=await this.consumerReady;this.ended=true;
    await new Promise<void>((resolve,reject)=>{const error=(value:Error)=>reject(value);socket.once('error',error);socket.end(()=>{socket.off('error',error);resolve();});});
    this.detachAbort?.();this.producerServer?.close();this.consumerServer?.close();
  }
  close(error?:Error){
    this.ended=true;this.detachAbort?.();if(error){this.failure=error;this.rejectConsumer(error);this.expected?.reject(error);}this.expected=undefined;
    for(const socket of this.producers)socket.destroy();this.producers.clear();this.consumer?.destroy();this.producerServer?.close();this.consumerServer?.close();
  }
}
