import { type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

// Solid (bold) duotone icons everywhere.
import { BotIcon, BugIcon, DangerTriangleIcon, WidgetIcon } from '@solar-icons/react/bold-duotone';

import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
} from '@page/design-system/components/ui/sidebar';

import { Avatar, AvatarFallback } from '@page/design-system/components/ui/avatar';

import ConnectionBadge from '../issues/ConnectionBadge';
import SignedInAs from '../issues/SignedInAs';
import Logo from './Logo';
import ThemeSwitch from './ThemeSwitch';

interface DashboardLayoutProps {
  children: ReactNode;
}

const navigation = [
  { title: 'Dashboard', icon: WidgetIcon, path: '/' },
  { title: 'Incidents', icon: DangerTriangleIcon, path: '/incidents' },
  { title: 'Agents', icon: BotIcon, path: '/agents' },
  { title: 'Debugging', icon: BugIcon, path: '/debug' },
] as const;

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const { pathname } = useLocation();

  const isActivePath = (path: string) =>
    pathname === path || (path !== '/' && pathname.startsWith(`${path}/`));

  return (
    <SidebarProvider className="pt-16">
      {/* One bar across the top, above the sidebar and the page, as on oklch.fyi. */}
      <header className="fixed inset-x-0 top-0 z-20 flex h-16 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur md:px-6">
        <div className="flex items-center gap-3">
          <SidebarTrigger className="md:hidden" />
          <NavLink to="/" aria-label="Page.AI home" className="rounded-md">
            <Logo />
          </NavLink>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <SignedInAs />
          <ConnectionBadge />
          <ThemeSwitch />
          <Avatar className="size-8">
            <AvatarFallback>JD</AvatarFallback>
          </Avatar>
        </div>
      </header>

      <Sidebar collapsible="icon" className="top-16 h-[calc(100svh-4rem)] border-sidebar-border">
        <SidebarHeader className="px-3 pt-5 pb-0">
          <SidebarTrigger className="hidden text-muted-foreground md:flex" />
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup className="px-3 py-3">
            <SidebarGroupLabel className="sr-only">Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {navigation.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      tooltip={item.title}
                      isActive={isActivePath(item.path)}
                      render={<NavLink to={item.path} />}
                      className="h-10 rounded-md text-[15px] [&_svg]:size-5"
                    >
                      <item.icon />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="p-3 group-data-[collapsible=icon]:hidden">
          <div className="rounded-md border border-border p-1">
            <div className="flex items-center gap-3 rounded-md bg-card px-3 py-2">
              <Avatar className="size-7 shrink-0">
                <AvatarFallback>JD</AvatarFallback>
              </Avatar>
              <span className="truncate text-sm font-medium">Demo User</span>
            </div>
            <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground">Workspace</p>
          </div>
        </SidebarFooter>
      </Sidebar>

      {/* min-w-0 lets a wide table scroll inside its card instead of widening the page. */}
      <SidebarInset className="min-w-0">
        <div className="flex-1 px-4 pt-10 pb-16 md:px-10">
          <div className="mx-auto w-full max-w-6xl">{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
