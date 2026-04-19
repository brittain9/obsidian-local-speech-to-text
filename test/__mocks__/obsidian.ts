export const Platform = {
  isMacOS: false,
  isWin: false,
  isLinux: true,
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
};

export class Notice {
  static instances: Array<{ message: string }> = [];
  constructor(public readonly message: string) {
    Notice.instances.push({ message });
  }
}

export function setIcon(_parent: unknown, _iconId: string): void {
  // no-op in tests
}
