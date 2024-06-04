using System.Net;

class MyClass {
    public static void routine()
    {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls;
        System.Net.ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls;
    }
}
