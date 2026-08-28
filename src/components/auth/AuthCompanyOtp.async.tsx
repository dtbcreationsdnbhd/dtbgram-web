import { Bundles } from '../../util/moduleLoader';

import useModuleLoader from '../../hooks/useModuleLoader';

import Loading from '../ui/Loading';

const AuthCompanyOtpAsync = () => {
  const AuthCompanyOtp = useModuleLoader(Bundles.Auth, 'AuthCompanyOtp');

  return AuthCompanyOtp ? <AuthCompanyOtp /> : <Loading />;
};

export default AuthCompanyOtpAsync;
