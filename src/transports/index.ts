export { ProviderRegistry } from './providerRegistry';

// Transport adapters
export type { TransportAdapter, SendOptions } from './transportAdapter';
export { UsbHidAdapter } from './usbHidAdapter';
export type { UsbHidAdapterOptions } from './usbHidAdapter';
export { TcpSocketAdapter } from './tcpSocketAdapter';
export type { TcpAdapterOptions, TcpDiscoveryInfo } from './tcpSocketAdapter';
export { BtSppAdapter } from './btSppAdapter';
export type { BtSppAdapterOptions } from './btSppAdapter';

// Transport providers
export { UsbTransportProvider } from './usbTransportProvider';
export { TcpTransportProvider } from './tcpTransportProvider';
export type { TcpTransportProviderOptions } from './tcpTransportProvider';
export { BtTransportProvider } from './btTransportProvider';
export type { BtTransportProviderOptions, BtBackend, BtAdapterFactory, BtDiscoveryDevice, BtDiscoveryFunction } from './btTransportProvider';

// Infrastructure
export { BtConnectionQueue } from './btConnectionQueue';
export { TransportGuard } from './transportGuard';
export type { DegradationCallback, TransportGuardOptions } from './transportGuard';
export { USB, TCP, BT, FIRMWARE_SAFETY } from './transportConstants';
