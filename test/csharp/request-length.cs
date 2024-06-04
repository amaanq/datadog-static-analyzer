public class MyController : Controller
{
    [DisableRequestSizeLimit]
    public IActionResult MyRequest()
    {
        Console.WriteLine("inside controller");
    }
}