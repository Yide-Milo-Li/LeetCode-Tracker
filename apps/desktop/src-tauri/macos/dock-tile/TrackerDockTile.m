#import <AppKit/AppKit.h>

// The Dock hosts this plug-in in a separate process, including while Tracker is closed.
@interface TrackerDockTile : NSObject <NSDockTilePlugIn>
@property (strong) NSDockTile *tile;
@property (strong) NSBundle *appBundle;
@end

@implementation TrackerDockTile

- (void)setDockTile:(NSDockTile *)tile {
    NSDistributedNotificationCenter *center = NSDistributedNotificationCenter.defaultCenter;
    [center removeObserver:self];
    self.tile = tile;
    if (!tile) return;

    // <app>/Contents/PlugIns/TrackerDockTile.docktileplugin
    NSURL *url = [NSBundle bundleForClass:self.class].bundleURL;
    NSURL *hostURL = url.URLByDeletingLastPathComponent.URLByDeletingLastPathComponent.URLByDeletingLastPathComponent;
    self.appBundle = [NSBundle bundleWithURL:hostURL];
    [center addObserver:self selector:@selector(refresh:)
                   name:@"LeetCodeTrackerDockIconChanged" object:self.appBundle.bundlePath
     suspensionBehavior:NSNotificationSuspensionBehaviorDeliverImmediately];
    [self refresh:nil];
}

- (void)refresh:(NSNotification *)notification {
    NSURL *support = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory
                                                          inDomains:NSUserDomainMask].firstObject;
    NSURL *profile = [support URLByAppendingPathComponent:self.appBundle.bundleIdentifier isDirectory:YES];
    NSImage *image = [[NSImage alloc] initWithContentsOfURL:[profile URLByAppendingPathComponent:@"dock-icon.png"]];
    if (!image) {
        NSString *iconName = [self.appBundle objectForInfoDictionaryKey:@"CFBundleIconFile"];
        image = [[NSImage alloc] initWithContentsOfURL:[self.appBundle URLForResource:iconName withExtension:nil]];
    }
    NSImageView *view = [[NSImageView alloc] initWithFrame:(NSRect){NSZeroPoint, self.tile.size}];
    view.image = image;
    view.imageScaling = NSImageScaleProportionallyUpOrDown;
    view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.tile.contentView = view;
    [self.tile display];
}

@end
