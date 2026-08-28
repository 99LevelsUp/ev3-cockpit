export { ProviderRegistry } from './providerRegistry';

// Transport adapters
export type { TransportAdapter, SendOptions } from './transportAdapter';
export { UsbHidAdapter } from './usbHidAdapter';
export type { UsbHidAdapterOptions } from './usbHidAdapter';
export { UsbLibusbAdapter } from './usbLibusbAdapter';
export type { UsbLibusbAdapterOptions, UsbDeviceLocation } from './usbLibusbAdapter';
export { TcpSocketAdapter } from './tcpSocketAdapter';
export type { TcpAdapterOptions, TcpDiscoveryInfo } from './tcpSocketAdapter';
export { BtWinsockAdapter } from './btWinsockAdapter';
export type { BtWinsockAdapterOptions } from './btWinsockAdapter';
export { BtSppAdapter } from './btSppAdapter';
export type { BtSppAdapterOptions } from './btSppAdapter';
export { BtSppBackend, macFromPnpId, formatMac } from './btSppDiscovery';
export type { SppPeer } from './btSppDiscovery';

// Transport providers
export { UsbTransportProvider } from './usbTransportProvider';
export type {
	UsbTransportProviderOptions, UsbBackend, UsbProviderLog
} from './usbTransportProvider';
export { TcpTransportProvider } from './tcpTransportProvider';
export type { TcpTransportProviderOptions } from './tcpTransportProvider';
export { BtTransportProvider } from './btTransportProvider';
export type { BtTransportProviderOptions, BtBackend, BtAdapterFactory, BtDiscoveryDevice, BtDiscoveryFunction } from './btTransportProvider';

// Infrastructure
export { BtConnectionQueue } from './btConnectionQueue';
export { TransportGuard } from './transportGuard';
export type { DegradationCallback, TransportGuardOptions } from './transportGuard';
export { USB, TCP, BT, FIRMWARE_SAFETY } from './transportConstants';
