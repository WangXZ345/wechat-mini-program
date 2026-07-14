export interface LoginDemoAccount {
  label: string;
  value: string;
}

export interface LoginDemoConfig {
  defaultAccount: string;
  defaultPassword: string;
  accounts: LoginDemoAccount[];
}
